#!/bin/bash

# Git 更新腳本 - 自動處理用戶身份配置
# 使用方法: ./git_update.sh "提交訊息"

# 檢查是否提供了提交訊息
if [ -z "$1" ]; then
    echo "使用方法: ./git_update.sh \"提交訊息\""
    echo "例如: ./git_update.sh \"更新網格交易機器人功能\""
    exit 1
fi

COMMIT_MSG="$1"

# 檢查 Git 用戶身份是否已設置
if [ -z "$(git config --global user.email)" ] || [ -z "$(git config --global user.name)" ]; then
    echo "檢測到 Git 用戶身份未設置，正在自動配置..."
    
    # 設置默認用戶身份
    git config --global user.email "clawbot0616@gmail.com"
    git config --global user.name "clawbot0616"
    
    echo "Git 用戶身份已設置完成"
fi

# 檢查並配置 Git credential helper（避免認證失敗）
if [ -z "$(git config --global credential.helper)" ]; then
    echo "檢測到 Git credential helper 未設置，正在自動配置..."
    git config --global credential.helper store
    echo "Git credential helper 已設置完成"
    echo "提示：首次推送時會提示輸入 GitHub 用戶名和 Personal Access Token"
fi

# 取得腳本所在路徑並切換至專案根目錄
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT" || {
    echo "❌ 無法切換至專案根目錄：$PROJECT_ROOT"
    exit 1
}

# 執行 Git 操作
echo "正在添加所有變更（在專案根目錄：$PROJECT_ROOT）..."
git add .

LOCK_FILE=".git/index.lock"

remove_lock_if_exists() {
    if [ -f "$LOCK_FILE" ]; then
        echo "偵測到 Git 鎖檔案，可能是先前操作異常終止所致。"
        echo "正在移除鎖檔案以繼續操作..."
        rm -f "$LOCK_FILE"
    fi
}

run_git_command() {
    local description="$1"
    shift  # 移除 description
    
    # 檢查第二個參數是否為 allow_failure 標誌
    local allow_failure="false"
    if [ "$1" = "true" ] || [ "$1" = "false" ]; then
        allow_failure="$1"
        shift  # 移除 allow_failure 標誌
    fi

    echo "$description"

    if ! "$@"; then
        if [ -f "$LOCK_FILE" ]; then
            echo "⚠️ Git 指令失敗並偵測到鎖檔案，將嘗試自動清除後再重試一次..."
            remove_lock_if_exists
            if ! "$@"; then
                if [ "$allow_failure" = "true" ]; then
                    echo "⚠️ Git 指令失敗，但允許繼續執行。"
                    return 1
                else
                    echo "❌ Git 指令仍然失敗，請手動檢查問題。"
                    exit 1
                fi
            fi
            return 0
        fi

        if [ "$allow_failure" = "true" ]; then
            echo "⚠️ Git 指令執行失敗，但允許繼續執行。"
            echo "   提示：您可能需要手動執行 'git push' 來推送變更。"
            return 1
        else
            echo "❌ Git 指令執行失敗，請檢查錯誤訊息。"
            exit 1
        fi
    fi
}

# 推送失敗時的幫助訊息函數
show_push_failure_help() {
    echo ""
    echo "⚠️  推送失敗，但本地提交已成功完成。"
    echo "   可能的原因："
    echo "   1. 未配置 Git 認證（Personal Access Token）"
    echo "   2. 在容器環境中無法使用 VSCode 認證助手"
    echo ""
    echo "   解決方案："
    echo "   方式 1（推薦）：設置 GITHUB_TOKEN 環境變數"
    echo "      export GITHUB_TOKEN='your_personal_access_token'"
    echo "      ./git_update.sh \"提交訊息\""
    echo ""
    echo "   方式 2：手動執行推送（會提示輸入認證資訊）"
    echo "      git push origin <目前分支>"
    echo "      （用戶名：您的 GitHub 用戶名，密碼：Personal Access Token）"
    echo ""
    echo "   方式 3：在 ~/.git-credentials 中手動添加認證"
    echo "      echo 'https://username:token@github.com' >> ~/.git-credentials"
}

# 檢查是否有變更需要提交
if [ -n "$(git status --porcelain)" ]; then
    # 有變更，執行提交
    run_git_command "正在提交變更..." git commit -m "$COMMIT_MSG"
else
    # 沒有變更，跳過提交
    echo "ℹ️  工作目錄沒有變更，跳過提交步驟。"
fi

# 自動取得目前分支，避免寫死分支名稱造成漏推
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ -z "$CURRENT_BRANCH" ] || [ "$CURRENT_BRANCH" = "HEAD" ]; then
    echo "❌ 無法取得目前分支（可能是 detached HEAD），請切換到分支後再執行。"
    exit 1
fi

# 判斷遠端是否已有同名分支
REMOTE_BRANCH_EXISTS="false"
if git show-ref --verify --quiet "refs/remotes/origin/${CURRENT_BRANCH}"; then
    REMOTE_BRANCH_EXISTS="true"
fi

# 檢查是否有本地提交需要推送
NEED_PUSH="false"
if [ "$REMOTE_BRANCH_EXISTS" = "true" ]; then
    if [ -n "$(git log "origin/${CURRENT_BRANCH}..HEAD" 2>/dev/null)" ]; then
        NEED_PUSH="true"
    fi
else
    # 遠端沒有分支時，視為需要首次推送
    NEED_PUSH="true"
fi

if [ "$NEED_PUSH" = "true" ]; then
    # 第一次推送新分支需要 -u，後續推送走一般 push
    if [ "$REMOTE_BRANCH_EXISTS" = "true" ]; then
        PUSH_ARGS=(git push origin "$CURRENT_BRANCH")
    else
        PUSH_ARGS=(git push -u origin "$CURRENT_BRANCH")
    fi

    ORIGINAL_REMOTE_URL="$(git remote get-url origin 2>/dev/null || true)"

    # 優先使用 GITHUB_TOKEN 環境變數（如果存在）
    if [ -n "$GITHUB_TOKEN" ]; then
        echo "正在推送到遠程倉庫（分支：$CURRENT_BRANCH，使用 GITHUB_TOKEN）..."
        if [ -n "$ORIGINAL_REMOTE_URL" ]; then
            # 以原始 origin URL 為基礎插入 token，避免寫死倉庫網址
            TOKEN_REMOTE_URL="${ORIGINAL_REMOTE_URL/https:\/\//https:\/\/${GITHUB_TOKEN}@}"
            git remote set-url origin "$TOKEN_REMOTE_URL" 2>/dev/null || true
        fi

        if ! run_git_command "正在推送到遠程倉庫（分支：$CURRENT_BRANCH）..." "true" "${PUSH_ARGS[@]}"; then
            # 如果失敗，恢復原始 URL
            if [ -n "$ORIGINAL_REMOTE_URL" ]; then
                git remote set-url origin "$ORIGINAL_REMOTE_URL" 2>/dev/null || true
            fi
            show_push_failure_help
        else
            # 成功後恢復原始 URL（避免 Token 殘留）
            if [ -n "$ORIGINAL_REMOTE_URL" ]; then
                git remote set-url origin "$ORIGINAL_REMOTE_URL" 2>/dev/null || true
            fi
        fi
    else
        # 使用 credential helper 方式
        if ! run_git_command "正在推送到遠程倉庫（分支：$CURRENT_BRANCH）..." "true" "${PUSH_ARGS[@]}"; then
            show_push_failure_help
        fi
    fi
else
    echo "ℹ️  目前分支（$CURRENT_BRANCH）沒有需要推送的本地提交。"
fi

echo ""
echo "✅ 所有操作完成！"
