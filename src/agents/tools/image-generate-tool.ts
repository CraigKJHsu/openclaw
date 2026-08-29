/**
 * image_generate built-in tool.
 *
 * Loads references, resolves providers/options, saves generated images, and supports detached background runs.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { parseImageGenerationModelRef } from "../../image-generation/model-ref.js";
import {
  generateImage,
  listRuntimeImageGenerationProviders,
} from "../../image-generation/runtime.js";
import type {
  ImageGenerationIgnoredOverride,
  ImageGenerationBackground,
  ImageGenerationOpenAIBackground,
  ImageGenerationOpenAIModeration,
  ImageGenerationOpenAIOptions,
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationProviderOptions,
  ImageGenerationQuality,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "../../image-generation/types.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  resolveConfiguredMediaMaxBytes,
  resolveGeneratedMediaMaxBytes,
} from "../../media/configured-max-bytes.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import { getImageMetadata } from "../../media/media-services.js";
import { saveMediaBuffer } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { resolveUserPath } from "../../utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  formatGeneratedAttachmentLines,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import {
  buildMediaGenerationRequestKey,
  recordRecentMediaGenerationTaskStartForSession,
} from "../media-generation-task-status-shared.js";
import { optionalStringEnum } from "../schema/string-enum.js";
import {
  ToolInputError,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readStringParam,
} from "./common.js";
import {
  completeImageGenerationTaskRun,
  createImageGenerationTaskRun,
  failImageGenerationTaskRun,
  imageGenerationTaskLifecycle,
  recordImageGenerationTaskProgress,
  type ImageGenerationTaskHandle,
} from "./image-generate-background.js";
import {
  createImageGenerateDuplicateGuardResult,
  createImageGenerateListActionResult,
  createImageGenerateStatusActionResult,
} from "./image-generate-tool.actions.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import {
  buildMediaGenerationStartedToolResult,
  createDefaultMediaGenerateBackgroundScheduler,
  notifyMediaGenerationAsyncTaskStarted,
  scheduleMediaGenerationTaskCompletion,
  shouldDetachMediaGenerationTask,
  type MediaGenerateAsyncStartCallback,
  type MediaGenerateBackgroundScheduler,
} from "./media-generate-background-shared.js";
import {
  applyImageGenerationModelConfigDefaults,
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  hasGenerationToolAvailability,
  normalizeMediaReferenceInputs,
  readGenerationTimeoutMs,
  REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS,
  resolveRemoteMediaSsrfPolicy,
  resolveCapabilityModelConfigForTool,
  resolveGenerateAction,
  resolveMediaToolLocalRoots,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import {
  coerceToolModelConfig,
  hasToolModelConfig,
  type ToolModelConfig,
} from "./model-config.helpers.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const DEFAULT_COUNT = 1;
const MAX_COUNT = 4;
const MAX_INPUT_IMAGES = 10;
const DEFAULT_RESOLUTION: ImageGenerationResolution = "1K";
const SUPPORTED_QUALITIES = ["low", "medium", "high", "auto"] as const;
const SUPPORTED_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const SUPPORTED_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const SUPPORTED_OPENAI_MODERATIONS = ["low", "auto"] as const;
const SUPPORTED_FAL_CREATIVITY = ["raw", "low", "medium", "high"] as const;
type FalCreativity = (typeof SUPPORTED_FAL_CREATIVITY)[number];
const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "2.35:1",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
  "4:1",
  "1:4",
  "8:1",
  "1:8",
]);

const log = createSubsystemLogger("agents/tools/image-generate");

const AI_DISCLOSURE_LABEL = "AI-ASSISTED VISUAL";
const PAGE_HERO_DISCLOSURE_LABEL = "AI-assisted visual";
const AI_DISCLOSURE_FONT: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11110", "00000", "00000", "00000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "01010", "01010", "00100"],
  a: ["00000", "00000", "01110", "00001", "01111", "10001", "01111"],
  d: ["00001", "00001", "01101", "10011", "10001", "10001", "01111"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01111"],
  i: ["00100", "00000", "01100", "00100", "00100", "00100", "01110"],
  l: ["01100", "00100", "00100", "00100", "00100", "00100", "01110"],
  s: ["00000", "00000", "01111", "10000", "01110", "00001", "11110"],
  t: ["00100", "00100", "11111", "00100", "00100", "00101", "00010"],
  u: ["00000", "00000", "10001", "10001", "10001", "10011", "01101"],
  v: ["00000", "00000", "10001", "10001", "10001", "01010", "00100"],
};

const ImageGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description: '"generate" default, "status" active task, "list" providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Image prompt." })),
  image: Type.Optional(
    Type.String({
      description: "Reference image path/URL for edit.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference images for edit or style reference; max ${MAX_INPUT_IMAGES}.`,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Provider/model override, e.g. openai/gpt-image-2; transparent OpenAI: openai/gpt-image-1.5.",
    }),
  ),
  filename: Type.Optional(
    Type.String({
      description: "Output filename hint; basename preserved in managed media dir.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: "Size hint: 1024x1024, 1536x1024, 1024x1536, 2048x2048, 3840x2160.",
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description:
        "Aspect ratio: 1:1, 2:3, 3:2, 2.35:1, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, 4:1, 1:4, 8:1, 1:8.",
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description: "Resolution: 1K, 2K, 4K; useful for Google.",
    }),
  ),
  quality: optionalStringEnum(SUPPORTED_QUALITIES, {
    description: "Quality: low, medium, high, auto.",
  }),
  outputFormat: optionalStringEnum(SUPPORTED_OUTPUT_FORMATS, {
    description: "Output format: png, jpeg, webp.",
  }),
  background: optionalStringEnum(SUPPORTED_BACKGROUNDS, {
    description: "Background: transparent, opaque, auto. Transparent needs png/webp output.",
  }),
  openai: Type.Optional(
    Type.Object({
      background: optionalStringEnum(SUPPORTED_BACKGROUNDS, {
        description:
          "OpenAI background: transparent, opaque, auto. Transparent needs png/webp; default model routes to gpt-image-1.5.",
      }),
      moderation: optionalStringEnum(SUPPORTED_OPENAI_MODERATIONS, {
        description: "OpenAI moderation: low, auto.",
      }),
      outputCompression: Type.Optional(
        Type.Integer({
          description: "OpenAI jpeg/webp compression 0-100.",
          minimum: 0,
          maximum: 100,
        }),
      ),
      user: Type.Optional(
        Type.String({
          description: "OpenAI stable end-user id.",
        }),
      ),
    }),
  ),
  fal: Type.Optional(
    Type.Object({
      creativity: optionalStringEnum(SUPPORTED_FAL_CREATIVITY, {
        description: "fal Krea creativity: raw, low, medium, high.",
      }),
    }),
  ),
  count: Type.Optional(
    Type.Integer({
      description: `Image count 1-${MAX_COUNT}.`,
      minimum: 1,
      maximum: MAX_COUNT,
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: "Provider timeout ms (300000 tends to be a safe amount).",
      minimum: 1,
    }),
  ),
});

export function resolveImageGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): ToolModelConfig | null {
  return resolveCapabilityModelConfigForTool({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
    modelConfig: params.cfg?.agents?.defaults?.imageGenerationModel,
    providers: () => listRuntimeImageGenerationProviders({ config: params.cfg }),
  });
}

function hasExplicitImageGenerationModelConfig(cfg?: OpenClawConfig): boolean {
  return hasToolModelConfig(coerceToolModelConfig(cfg?.agents?.defaults?.imageGenerationModel));
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" | "status" {
  return resolveGenerateAction({
    args,
    allowed: ["generate", "status", "list"],
    defaultAction: "generate",
  });
}

function resolveRequestedCount(args: Record<string, unknown>): number {
  if (readSnakeCaseParamRaw(args, "count") === null) {
    throw new ToolInputError(`count must be between 1 and ${MAX_COUNT}`);
  }
  const count = readPositiveIntegerParam(args, "count", {
    message: `count must be between 1 and ${MAX_COUNT}`,
  });
  if (count === undefined) {
    return DEFAULT_COUNT;
  }
  if (count < 1 || count > MAX_COUNT) {
    throw new ToolInputError(`count must be between 1 and ${MAX_COUNT}`);
  }
  return count;
}

function normalizeResolution(raw: string | undefined): ImageGenerationResolution | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1K" || normalized === "2K" || normalized === "4K") {
    return normalized;
  }
  throw new ToolInputError("resolution must be one of 1K, 2K, or 4K");
}

function normalizeAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError(
    "aspectRatio must be one of 1:1, 2:3, 3:2, 2.35:1, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, 4:1, 1:4, 8:1, or 1:8",
  );
}

function normalizeQuality(raw: string | undefined): ImageGenerationQuality | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_QUALITIES as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationQuality;
  }
  throw new ToolInputError("quality must be one of low, medium, high, or auto");
}

function normalizeOutputFormat(raw: string | undefined): ImageGenerationOutputFormat | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_OUTPUT_FORMATS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationOutputFormat;
  }
  throw new ToolInputError("outputFormat must be one of png, jpeg, or webp");
}

function normalizeOpenAIBackground(
  raw: string | undefined,
): ImageGenerationOpenAIBackground | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_BACKGROUNDS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationOpenAIBackground;
  }
  throw new ToolInputError("openai.background must be one of transparent, opaque, or auto");
}

function normalizeBackground(raw: string | undefined): ImageGenerationBackground | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_BACKGROUNDS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationBackground;
  }
  throw new ToolInputError("background must be one of transparent, opaque, or auto");
}

function normalizeOpenAIModeration(
  raw: string | undefined,
): ImageGenerationOpenAIModeration | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_OPENAI_MODERATIONS as readonly string[]).includes(normalized)) {
    return normalized as ImageGenerationOpenAIModeration;
  }
  throw new ToolInputError("openai.moderation must be one of low or auto");
}

function normalizeFalCreativity(raw: string | undefined): FalCreativity | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if ((SUPPORTED_FAL_CREATIVITY as readonly string[]).includes(normalized)) {
    return normalized as FalCreativity;
  }
  throw new ToolInputError("fal.creativity must be one of raw, low, medium, or high");
}

function readRecordParam(params: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = params[key];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function normalizeOpenAIOptions(args: Record<string, unknown>): ImageGenerationOpenAIOptions {
  const raw = readRecordParam(args, "openai");
  const background = normalizeOpenAIBackground(readStringParam(raw, "background"));
  const moderation = normalizeOpenAIModeration(readStringParam(raw, "moderation"));
  if (readSnakeCaseParamRaw(raw, "outputCompression") === null) {
    throw new ToolInputError("openai.outputCompression must be between 0 and 100");
  }
  const outputCompression = readNonNegativeIntegerParam(raw, "outputCompression", {
    message: "openai.outputCompression must be between 0 and 100",
  });
  const user = readStringParam(raw, "user");
  if (outputCompression !== undefined && (outputCompression < 0 || outputCompression > 100)) {
    throw new ToolInputError("openai.outputCompression must be between 0 and 100");
  }
  return {
    ...(background ? { background } : {}),
    ...(moderation ? { moderation } : {}),
    ...(outputCompression !== undefined ? { outputCompression } : {}),
    ...(user ? { user } : {}),
  };
}

function normalizeProviderOptions(
  args: Record<string, unknown>,
): ImageGenerationProviderOptions | undefined {
  const falRaw = readRecordParam(args, "fal");
  const falCreativity = normalizeFalCreativity(readStringParam(falRaw, "creativity"));
  const openai = normalizeOpenAIOptions(args);
  const fal = falCreativity ? { creativity: falCreativity } : undefined;
  return fal || Object.keys(openai).length > 0
    ? { ...(fal ? { fal } : {}), ...(Object.keys(openai).length > 0 ? { openai } : {}) }
    : undefined;
}

function normalizeReferenceImages(args: Record<string, unknown>): string[] {
  return normalizeMediaReferenceInputs({
    args,
    singularKey: "image",
    pluralKey: "images",
    maxCount: MAX_INPUT_IMAGES,
    label: "reference images",
  });
}

function resolveSelectedImageGenerationProvider(params: {
  config?: OpenClawConfig;
  imageGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): ImageGenerationProvider | undefined {
  return resolveSelectedCapabilityProvider({
    providers: listRuntimeImageGenerationProviders({ config: params.config }),
    modelConfig: params.imageGenerationModelConfig,
    modelOverride: params.modelOverride,
    parseModelRef: parseImageGenerationModelRef,
  });
}

function resolveSelectedImageGenerationModelId(params: {
  selectedProvider: ImageGenerationProvider | undefined;
  imageGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
  explicitModelRef: { provider: string; model: string } | null;
  primaryModelRef: { provider: string; model: string } | null;
}): string | undefined {
  const selectedProviderId = params.selectedProvider?.id;
  const explicitModelRef = params.explicitModelRef;
  const primaryModelRef = params.primaryModelRef;
  if (params.modelOverride !== undefined) {
    if (explicitModelRef && explicitModelRef.provider === selectedProviderId) {
      return explicitModelRef.model;
    }
    if (params.selectedProvider?.models?.includes(params.modelOverride)) {
      return params.modelOverride;
    }
    return explicitModelRef?.model ?? params.modelOverride;
  }
  if (primaryModelRef && primaryModelRef.provider === selectedProviderId) {
    return primaryModelRef.model;
  }
  return params.imageGenerationModelConfig.primary ?? params.selectedProvider?.defaultModel;
}

function isFalKreaImageModel(provider: ImageGenerationProvider | undefined, modelId?: string) {
  return provider?.id === "fal" && modelId?.startsWith("krea/v2/") === true;
}

function formatIgnoredImageGenerationOverride(override: ImageGenerationIgnoredOverride): string {
  return `${override.key}=${sanitizeInlineDirectiveText(override.value)}`;
}

function sanitizeInlineDirectiveText(value: string): string {
  let sanitized = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        sanitized += "\\\\";
        break;
      case "\r":
        sanitized += "\\r";
        break;
      case "\n":
        sanitized += "\\n";
        break;
      case "\t":
        sanitized += "\\t";
        break;
      default:
        if (isInlineDirectiveControlCharacter(char)) {
          sanitized += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
        } else {
          sanitized += char;
        }
    }
  }
  return sanitized;
}

function isInlineDirectiveControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
}

function validateImageGenerationCapabilities(params: {
  provider: ImageGenerationProvider | undefined;
  count: number;
  inputImageCount: number;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  explicitResolution?: boolean;
}) {
  const provider = params.provider;
  if (!provider) {
    return;
  }
  const isEdit = params.inputImageCount > 0;
  const modeCaps = isEdit ? provider.capabilities.edit : provider.capabilities.generate;
  const maxCount = modeCaps.maxCount ?? MAX_COUNT;
  if (params.count > maxCount) {
    throw new ToolInputError(
      `${provider.id} ${isEdit ? "edit" : "generate"} supports at most ${maxCount} output image${maxCount === 1 ? "" : "s"}.`,
    );
  }

  if (isEdit) {
    if (!provider.capabilities.edit.enabled) {
      throw new ToolInputError(`${provider.id} does not support reference-image edits.`);
    }
    const maxInputImages = provider.capabilities.edit.maxInputImages ?? MAX_INPUT_IMAGES;
    if (params.inputImageCount > maxInputImages) {
      throw new ToolInputError(
        `${provider.id} edit supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
      );
    }
  }
}

type ImageGenerateSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

async function loadReferenceImages(params: {
  imageInputs: string[];
  maxBytes?: number;
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
  ssrfPolicy?: SsrFPolicy;
}): Promise<
  Array<{
    sourceImage: ImageGenerationSourceImage;
    resolvedImage: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded: Array<{
    sourceImage: ImageGenerationSourceImage;
    resolvedImage: string;
    rewrittenFrom?: string;
  }> = [];

  for (const imageRawInput of params.imageInputs) {
    const trimmed = imageRawInput.trim();
    const imageRaw = normalizeMediaReferenceSource(
      trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed,
    );
    if (!imageRaw) {
      throw new ToolInputError("image required (empty string in array)");
    }
    const refInfo = classifyMediaReferenceSource(imageRaw);
    const { isDataUrl, isHttpUrl } = refInfo;
    if (refInfo.hasUnsupportedScheme) {
      throw new ToolInputError(
        `Unsupported image reference: ${imageRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandboxConfig && isHttpUrl) {
      throw new ToolInputError("Sandboxed image_generate does not allow remote URLs.");
    }

    const resolvedImage = (() => {
      if (params.sandboxConfig) {
        return imageRaw;
      }
      if (imageRaw.startsWith("~")) {
        return resolveUserPath(imageRaw);
      }
      return imageRaw;
    })();

    const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
      ? { resolved: "" }
      : params.sandboxConfig
        ? await resolveSandboxedBridgeMediaPath({
            sandbox: params.sandboxConfig,
            mediaPath: resolvedImage,
            inboundFallbackDir: "media/inbound",
          })
        : {
            resolved: resolvedImage.startsWith("file://")
              ? resolvedImage.slice("file://".length)
              : resolvedImage,
          };
    const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;

    const localRoots = resolveMediaToolLocalRoots(
      params.workspaceDir,
      {
        workspaceOnly: params.sandboxConfig?.workspaceOnly === true,
      },
      resolvedPath ? [resolvedPath] : undefined,
    );

    const media = isDataUrl
      ? decodeDataUrl(resolvedImage, { maxBytes: params.maxBytes })
      : params.sandboxConfig
        ? await loadWebMedia(resolvedPath ?? resolvedImage, {
            maxBytes: params.maxBytes,
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
          })
        : await loadWebMedia(resolvedPath ?? resolvedImage, {
            maxBytes: params.maxBytes,
            localRoots,
            ssrfPolicy: params.ssrfPolicy,
            ...(isHttpUrl ? { readIdleTimeoutMs: REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS } : {}),
          });
    if (media.kind !== "image") {
      throw new ToolInputError(`Unsupported media type: ${media.kind}`);
    }

    const mimeType =
      ("contentType" in media && media.contentType) ||
      ("mimeType" in media && media.mimeType) ||
      "image/png";

    loaded.push({
      sourceImage: {
        buffer: media.buffer,
        mimeType,
      },
      resolvedImage,
      ...(resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}),
    });
  }

  return loaded;
}

async function inferResolutionFromInputImages(
  images: ImageGenerationSourceImage[],
): Promise<ImageGenerationResolution> {
  let maxDimension = 0;
  for (const image of images) {
    const meta = await getImageMetadata(image.buffer);
    const dimension = Math.max(meta?.width ?? 0, meta?.height ?? 0);
    maxDimension = Math.max(maxDimension, dimension);
  }
  if (maxDimension >= 3000) {
    return "4K";
  }
  if (maxDimension >= 1500) {
    return "2K";
  }
  return DEFAULT_RESOLUTION;
}

type LoadedReferenceImage = Awaited<ReturnType<typeof loadReferenceImages>>[number];

type ExecutedImageGeneration = {
  provider: string;
  model: string;
  savedPaths: string[];
  count: number;
  paths: string[];
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

type PngImage = {
  width: number;
  height: number;
  data: Buffer;
};

type PngConstructor = {
  new (params: { width: number; height: number }): PngImage;
  sync: {
    read: (buffer: Buffer) => PngImage;
    write: (image: PngImage) => Buffer;
  };
  bitblt: (
    source: PngImage,
    destination: PngImage,
    srcX: number,
    srcY: number,
    width: number,
    height: number,
    deltaX: number,
    deltaY: number,
  ) => void;
};

const require = createRequire(import.meta.url);
const PNG = (require("pngjs") as { PNG: PngConstructor }).PNG;
const MAX_ASPECT_RATIO_CANONICALIZATION_CROP_FRACTION = 0.03;

function parseAspectRatioPair(value?: string): { width: number; height: number } | null {
  const match = String(value ?? "")
    .trim()
    .match(/^([1-9][0-9]*)\s*:\s*([1-9][0-9]*)$/);
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function exactAspectRatioCropBox(params: {
  width: number;
  height: number;
  ratioWidth: number;
  ratioHeight: number;
}): { x: number; y: number; width: number; height: number } | null {
  if (params.width * params.ratioHeight === params.height * params.ratioWidth) {
    return null;
  }
  const widthFirst = Math.floor(params.width / params.ratioWidth) * params.ratioWidth;
  const widthFirstHeight = (widthFirst / params.ratioWidth) * params.ratioHeight;
  const heightFirst = Math.floor(params.height / params.ratioHeight) * params.ratioHeight;
  const heightFirstWidth = (heightFirst / params.ratioHeight) * params.ratioWidth;
  const candidates = [
    { width: widthFirst, height: widthFirstHeight },
    { width: heightFirstWidth, height: heightFirst },
  ].filter(
    (candidate) =>
      Number.isInteger(candidate.width) &&
      Number.isInteger(candidate.height) &&
      candidate.width > 0 &&
      candidate.height > 0 &&
      candidate.width <= params.width &&
      candidate.height <= params.height,
  );
  const best = candidates.toSorted((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!best) {
    return null;
  }
  const removedPixels = params.width * params.height - best.width * best.height;
  const cropFraction = removedPixels / (params.width * params.height);
  if (cropFraction > MAX_ASPECT_RATIO_CANONICALIZATION_CROP_FRACTION) {
    return null;
  }
  return {
    x: Math.floor((params.width - best.width) / 2),
    y: Math.floor((params.height - best.height) / 2),
    width: best.width,
    height: best.height,
  };
}

function exactAspectRatioPaddedSize(params: {
  width: number;
  height: number;
  ratioWidth: number;
  ratioHeight: number;
}): { width: number; height: number } | null {
  if (params.width * params.ratioHeight === params.height * params.ratioWidth) {
    return null;
  }
  if (params.width * params.ratioHeight < params.height * params.ratioWidth) {
    const targetHeight = Math.floor(params.height / params.ratioHeight) * params.ratioHeight;
    const targetWidth = (targetHeight / params.ratioHeight) * params.ratioWidth;
    if (targetWidth >= params.width && targetHeight >= params.height) {
      return { width: targetWidth, height: targetHeight };
    }
    const fallbackHeight = Math.ceil(params.height / params.ratioHeight) * params.ratioHeight;
    return {
      width: (fallbackHeight / params.ratioHeight) * params.ratioWidth,
      height: fallbackHeight,
    };
  }
  const targetWidth = Math.floor(params.width / params.ratioWidth) * params.ratioWidth;
  const targetHeight = (targetWidth / params.ratioWidth) * params.ratioHeight;
  if (targetWidth >= params.width && targetHeight >= params.height) {
    return { width: targetWidth, height: targetHeight };
  }
  const fallbackWidth = Math.ceil(params.width / params.ratioWidth) * params.ratioWidth;
  return {
    width: fallbackWidth,
    height: (fallbackWidth / params.ratioWidth) * params.ratioHeight,
  };
}

function padPngToAspectRatio(params: { png: PngImage; ratioWidth: number; ratioHeight: number }): {
  png: PngImage;
  padded: boolean;
} {
  const size = exactAspectRatioPaddedSize({
    width: params.png.width,
    height: params.png.height,
    ratioWidth: params.ratioWidth,
    ratioHeight: params.ratioHeight,
  });
  if (!size) {
    return { png: params.png, padded: false };
  }
  const out = new PNG({ width: size.width, height: size.height });
  for (let offset = 0; offset < out.data.length; offset += 4) {
    out.data[offset] = 255;
    out.data[offset + 1] = 248;
    out.data[offset + 2] = 234;
    out.data[offset + 3] = 255;
  }
  PNG.bitblt(
    params.png,
    out,
    0,
    0,
    params.png.width,
    params.png.height,
    Math.floor((size.width - params.png.width) / 2),
    Math.floor((size.height - params.png.height) / 2),
  );
  return { png: out, padded: true };
}

async function canonicalizeGeneratedImageAspectRatio(params: {
  buffer: Buffer;
  mimeType: string;
  aspectRatio?: string;
}): Promise<{
  buffer: Buffer;
  canonicalized: boolean;
  dimensions?: string;
}> {
  const ratio = parseAspectRatioPair(params.aspectRatio);
  if (!ratio || params.mimeType !== "image/png") {
    return { buffer: params.buffer, canonicalized: false };
  }
  try {
    const png = PNG.sync.read(params.buffer);
    const crop = exactAspectRatioCropBox({
      width: png.width,
      height: png.height,
      ratioWidth: ratio.width,
      ratioHeight: ratio.height,
    });
    if (!crop) {
      const padded = padPngToAspectRatio({
        png,
        ratioWidth: ratio.width,
        ratioHeight: ratio.height,
      });
      if (!padded.padded) {
        return { buffer: params.buffer, canonicalized: false };
      }
      return {
        buffer: PNG.sync.write(padded.png),
        canonicalized: true,
        dimensions: `${padded.png.width}x${padded.png.height}`,
      };
    }
    const out = new PNG({ width: crop.width, height: crop.height });
    PNG.bitblt(png, out, crop.x, crop.y, crop.width, crop.height, 0, 0);
    return {
      buffer: PNG.sync.write(out),
      canonicalized: true,
      dimensions: `${crop.width}x${crop.height}`,
    };
  } catch {
    return { buffer: params.buffer, canonicalized: false };
  }
}

type AiDisclosureStyle = "audio-brief" | "page-hero";

function isPageHeroAsset(params: { filename?: string; prompt: string }): boolean {
  const filename = params.filename?.toLowerCase() ?? "";
  const prompt = params.prompt.toLowerCase();
  return (
    filename.includes("page_hero") ||
    filename.includes("page-hero") ||
    prompt.includes("asset_family: page_hero") ||
    prompt.includes("asset_family=page_hero")
  );
}

function sanitizePageHeroGenerationPrompt(params: { filename?: string; prompt: string }): string {
  if (!isPageHeroAsset(params)) {
    return params.prompt;
  }
  return params.prompt
    .replace(/AI[-\s]*assisted\s+visual/gi, "")
    .replace(/AI[-\s]*generated(?:\s+visual)?/gi, "")
    .replace(/AI\s+disclosure/gi, "")
    .replace(/AI\s*揭露/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function resolveAiDisclosureStyle(params: {
  filename?: string;
  prompt: string;
}): AiDisclosureStyle | undefined {
  const filename = params.filename?.toLowerCase() ?? "";
  const prompt = params.prompt.toLowerCase();
  const haystack = `${filename}\n${prompt}`;
  if (isPageHeroAsset(params)) {
    return "page-hero";
  }
  const isAudioBrief =
    prompt.includes("asset_family: audio_brief") ||
    prompt.includes("asset_family=audio_brief") ||
    filename.includes("audio_brief") ||
    filename.includes("audio-brief");
  const hasDisclosureIntent =
    haystack.includes("ai-assisted visual") ||
    haystack.includes("ai-generated") ||
    haystack.includes("ai disclosure") ||
    haystack.includes("揭露");
  const isAiBizWeek = haystack.includes("ai bizweek") || haystack.includes("aibizweek");
  return isAudioBrief && (hasDisclosureIntent || isAiBizWeek) ? "audio-brief" : undefined;
}

function blendPixel(
  png: PNG,
  x: number,
  y: number,
  color: { r: number; g: number; b: number; a: number },
) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    return;
  }
  const idx = (png.width * y + x) << 2;
  const alpha = Math.max(0, Math.min(1, color.a));
  png.data[idx] = Math.round(png.data[idx] * (1 - alpha) + color.r * alpha);
  png.data[idx + 1] = Math.round(png.data[idx + 1] * (1 - alpha) + color.g * alpha);
  png.data[idx + 2] = Math.round(png.data[idx + 2] * (1 - alpha) + color.b * alpha);
  png.data[idx + 3] = 255;
}

function fillRect(
  png: PNG,
  rect: { x: number; y: number; width: number; height: number },
  color: { r: number; g: number; b: number; a: number },
) {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      blendPixel(png, x, y, color);
    }
  }
}

function drawBitmapText(
  png: PNG,
  text: string,
  origin: { x: number; y: number },
  scale: number,
  color: { r: number; g: number; b: number; a: number },
) {
  let cursorX = origin.x;
  for (const char of text) {
    const glyph = AI_DISCLOSURE_FONT[char] ?? AI_DISCLOSURE_FONT[" "];
    for (const [row, bits] of glyph.entries()) {
      for (let col = 0; col < bits.length; col += 1) {
        if (bits[col] !== "1") {
          continue;
        }
        fillRect(
          png,
          {
            x: cursorX + col * scale,
            y: origin.y + row * scale,
            width: scale,
            height: scale,
          },
          color,
        );
      }
    }
    cursorX += 6 * scale;
  }
}

function overlayAiDisclosure(params: {
  buffer: Buffer;
  mimeType: string;
  style?: AiDisclosureStyle;
}): { buffer: Buffer; applied: true } | { buffer: Buffer; applied: false } {
  if (!params.style || params.mimeType !== "image/png") {
    return { buffer: params.buffer, applied: false };
  }
  try {
    const png = PNG.sync.read(params.buffer);
    const compact = params.style === "page-hero";
    const label = compact ? PAGE_HERO_DISCLOSURE_LABEL : AI_DISCLOSURE_LABEL;
    const scale = compact
      ? Math.max(2, Math.round(png.width / 1000))
      : Math.max(2, Math.round(png.width / 420));
    const textWidth = label.length * 6 * scale - scale;
    const textHeight = 7 * scale;
    const padX = compact ? 4 : Math.round(scale * 4);
    const padY = compact ? 3 : Math.round(scale * 3);
    const boxWidth = textWidth + padX * 2;
    const boxHeight = textHeight + padY * 2;
    const margin = compact ? 8 : Math.round(scale * 8);
    const bottomProgramStripReserve = compact ? 0 : Math.round(png.height * 0.11);
    const x = compact ? margin : Math.max(margin, png.width - boxWidth - margin);
    const y = Math.max(margin, png.height - bottomProgramStripReserve - boxHeight - margin);
    fillRect(
      png,
      { x, y, width: boxWidth, height: boxHeight },
      compact ? { r: 255, g: 248, b: 234, a: 0.72 } : { r: 0, g: 23, b: 43, a: 0.82 },
    );
    if (!compact) {
      fillRect(png, { x, y, width: boxWidth, height: scale }, { r: 242, g: 182, b: 43, a: 0.95 });
      fillRect(
        png,
        { x, y: y + boxHeight - scale, width: boxWidth, height: scale },
        { r: 242, g: 182, b: 43, a: 0.95 },
      );
      fillRect(png, { x, y, width: scale, height: boxHeight }, { r: 242, g: 182, b: 43, a: 0.95 });
      fillRect(
        png,
        { x: x + boxWidth - scale, y, width: scale, height: boxHeight },
        { r: 242, g: 182, b: 43, a: 0.95 },
      );
    }
    drawBitmapText(
      png,
      label,
      { x: x + padX, y: y + padY },
      scale,
      compact ? { r: 48, g: 48, b: 48, a: 0.82 } : { r: 255, g: 255, b: 255, a: 1 },
    );
    return { buffer: PNG.sync.write(png), applied: true };
  } catch {
    return { buffer: params.buffer, applied: false };
  }
}

async function buildGeneratedImageMetadata(image: { buffer: Buffer }): Promise<{
  width?: number;
  height?: number;
  dimensions?: string;
  sha256: string;
}> {
  const sha256 = createHash("sha256").update(image.buffer).digest("hex");
  try {
    const metadata = await getImageMetadata(image.buffer);
    const width = metadata?.width;
    const height = metadata?.height;
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return { width, height, dimensions: `${width}x${height}`, sha256 };
    }
  } catch {
    // Keep the generated file usable even when the probe backend cannot decode it.
  }
  return { sha256 };
}

const defaultScheduleImageGenerateBackgroundWork = createDefaultMediaGenerateBackgroundScheduler({
  toolName: "image_generate",
  onCrash: (message, meta) => log.error(message, meta),
});

async function executeImageGenerationJob(params: {
  effectiveCfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationOutputFormat;
  background?: ImageGenerationBackground;
  count: number;
  inputImages: ImageGenerationSourceImage[];
  timeoutMs?: number;
  providerOptions?: ImageGenerationProviderOptions;
  ssrfPolicy?: SsrFPolicy;
  filename?: string;
  loadedReferenceImages: LoadedReferenceImage[];
  taskHandle?: ImageGenerationTaskHandle | null;
  autoProviderFallback?: boolean;
}) {
  if (params.taskHandle) {
    recordImageGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating image",
    });
  }
  const result = await generateImage({
    cfg: params.effectiveCfg,
    prompt: sanitizePageHeroGenerationPrompt({
      filename: params.filename,
      prompt: params.prompt,
    }),
    agentDir: params.agentDir,
    modelOverride: params.model,
    autoProviderFallback: params.autoProviderFallback,
    size: params.size,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    quality: params.quality,
    outputFormat: params.outputFormat,
    background: params.background,
    count: params.count,
    inputImages: params.inputImages,
    timeoutMs: params.timeoutMs,
    providerOptions: params.providerOptions,
    ssrfPolicy: params.ssrfPolicy,
  });
  if (params.taskHandle) {
    recordImageGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated image",
    });
  }
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const displayProvider = sanitizeInlineDirectiveText(result.provider);
  const displayModel = sanitizeInlineDirectiveText(result.model);
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${displayProvider}/${displayModel}: ${ignoredOverrides.map(formatIgnoredImageGenerationOverride).join(", ")}.`
      : undefined;
  const normalizedSize =
    result.normalization?.size?.applied ??
    (typeof result.metadata?.normalizedSize === "string" && result.metadata.normalizedSize.trim()
      ? result.metadata.normalizedSize
      : undefined);
  const normalizedAspectRatio =
    result.normalization?.aspectRatio?.applied ??
    (typeof result.metadata?.normalizedAspectRatio === "string" &&
    result.metadata.normalizedAspectRatio.trim()
      ? result.metadata.normalizedAspectRatio
      : undefined);
  const normalizedResolution =
    result.normalization?.resolution?.applied ??
    (typeof result.metadata?.normalizedResolution === "string" &&
    result.metadata.normalizedResolution.trim()
      ? result.metadata.normalizedResolution
      : undefined);
  const sizeTranslatedToAspectRatio =
    result.normalization?.aspectRatio?.derivedFrom === "size" ||
    (!normalizedSize &&
      typeof result.metadata?.requestedSize === "string" &&
      result.metadata.requestedSize === params.size &&
      Boolean(normalizedAspectRatio));

  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "image");
  const aiDisclosureStyle = resolveAiDisclosureStyle({
    filename: params.filename,
    prompt: params.prompt,
  });
  const preparedImages = await Promise.all(
    result.images.map(async (image) => {
      const canonicalized = await canonicalizeGeneratedImageAspectRatio({
        buffer: image.buffer,
        mimeType: image.mimeType,
        aspectRatio: normalizedAspectRatio ?? params.aspectRatio,
      });
      const disclosure = overlayAiDisclosure({
        buffer: canonicalized.buffer,
        mimeType: image.mimeType,
        style: aiDisclosureStyle,
      });
      return {
        ...image,
        ...canonicalized,
        buffer: disclosure.buffer,
        aiDisclosureOverlayApplied: disclosure.applied,
      };
    }),
  );
  const savedImages = await Promise.all(
    preparedImages.map(async (image) => ({
      saved: await saveMediaBuffer(
        image.buffer,
        image.mimeType,
        "tool-image-generation",
        mediaMaxBytes,
        params.filename || image.fileName,
      ),
      metadata: await buildGeneratedImageMetadata(image),
      canonicalized: image.canonicalized,
      aiDisclosureOverlayApplied: image.aiDisclosureOverlayApplied,
    })),
  );

  const revisedPrompts = result.images
    .map((image) => image.revisedPrompt?.trim())
    .filter((entry): entry is string => Boolean(entry));
  const attachments = savedImages.map((image) => ({
    type: "image" as const,
    path: image.saved.path,
    mimeType: image.saved.contentType,
    name: image.saved.id,
    ...image.metadata,
  }));
  const lines = [
    `Generated ${savedImages.length} image${savedImages.length === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    ...(savedImages.some((image) => image.canonicalized)
      ? ["Normalized generated image crop to requested exact aspect ratio."]
      : []),
    ...(savedImages.some((image) => image.aiDisclosureOverlayApplied)
      ? ["Applied deterministic AI-assisted visual disclosure overlay."]
      : []),
    ...formatGeneratedAttachmentLines(attachments),
  ];
  return {
    provider: result.provider,
    model: result.model,
    savedPaths: savedImages.map((image) => image.saved.path),
    count: savedImages.length,
    paths: savedImages.map((image) => image.saved.path),
    attachments,
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: savedImages.length,
      media: {
        mediaUrls: savedImages.map((image) => image.saved.path),
        attachments,
      },
      attachments,
      paths: savedImages.map((image) => image.saved.path),
      ...(savedImages.some((image) => image.canonicalized)
        ? { aspectRatioCanonicalized: true }
        : {}),
      ...(savedImages.some((image) => image.aiDisclosureOverlayApplied)
        ? { aiDisclosureOverlayApplied: true }
        : {}),
      ...buildTaskRunDetails(params.taskHandle),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceImages,
        singleKey: "image",
        pluralKey: "images",
        getResolvedInput: (entry) => entry.resolvedImage,
      }),
      ...(normalizedResolution || params.resolution
        ? { resolution: normalizedResolution ?? params.resolution }
        : {}),
      ...(normalizedSize || (params.size && !sizeTranslatedToAspectRatio)
        ? { size: normalizedSize ?? params.size }
        : {}),
      ...(normalizedAspectRatio || params.aspectRatio
        ? { aspectRatio: normalizedAspectRatio ?? params.aspectRatio }
        : {}),
      ...(params.quality ? { quality: params.quality } : {}),
      ...(params.outputFormat ? { outputFormat: params.outputFormat } : {}),
      ...(params.background ? { background: params.background } : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
      ...(revisedPrompts.length > 0 ? { revisedPrompts } : {}),
    },
  } satisfies ExecutedImageGeneration;
}

export function createImageGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  agentSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  sandbox?: ImageGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: MediaGenerateBackgroundScheduler;
  onAsyncTaskStarted?: MediaGenerateAsyncStartCallback;
}): AnyAgentTool | null {
  const cfg = options?.config ?? getRuntimeConfig();
  if (
    !hasGenerationToolAvailability({
      cfg,
      agentDir: options?.agentDir,
      workspaceDir: options?.workspaceDir,
      authStore: options?.authProfileStore,
      modelConfig: cfg.agents?.defaults?.imageGenerationModel,
      providerKey: "imageGenerationProviders",
    })
  ) {
    return null;
  }
  const sandboxConfig =
    options?.sandbox && options.sandbox.root.trim()
      ? {
          root: options.sandbox.root.trim(),
          bridge: options.sandbox.bridge,
          workspaceOnly: options.fsPolicy?.workspaceOnly === true,
        }
      : null;
  const scheduleBackgroundWork =
    options?.scheduleBackgroundWork ?? defaultScheduleImageGenerateBackgroundWork;

  return {
    label: "Image Generation",
    name: "image_generate",
    description:
      'Create/edit images. Session chats: background task; do not call image_generate again for same request; wait completion, then report through the current visible-reply contract with generated media attached using structured media fields. Transparent: outputFormat="png" or "webp" + background="transparent"; OpenAI also supports openai.background and routes default model to gpt-image-1.5. Use action="list" for providers/models/readiness/auth, "status" for active task.',
    parameters: ImageGenerateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = resolveAction(params);
      if (action === "list") {
        return createImageGenerateListActionResult({
          cfg,
          workspaceDir: options?.workspaceDir,
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        });
      }
      if (action === "status") {
        return createImageGenerateStatusActionResult(options?.agentSessionKey);
      }

      const model = readStringParam(params, "model");
      const configuredImageGenerationModelConfig = coerceToolModelConfig(
        cfg.agents?.defaults?.imageGenerationModel,
      );
      const imageGenerationModelConfig =
        resolveImageGenerationModelConfigForTool({
          cfg,
          workspaceDir: options?.workspaceDir,
          agentDir: options?.agentDir,
          authStore: options?.authProfileStore,
        }) ?? (model ? { ...configuredImageGenerationModelConfig, primary: model } : null);
      if (!imageGenerationModelConfig) {
        throw new ToolInputError("No image-generation model configured.");
      }
      const explicitModelConfig = hasExplicitImageGenerationModelConfig(cfg);
      const effectiveCfg =
        applyImageGenerationModelConfigDefaults(cfg, imageGenerationModelConfig) ?? cfg;
      const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(effectiveCfg);
      const prompt = readStringParam(params, "prompt", { required: true });

      const activeDuplicateGuardResult = createImageGenerateDuplicateGuardResult(
        options?.agentSessionKey,
        { prompt },
      );
      if (activeDuplicateGuardResult) {
        return activeDuplicateGuardResult;
      }

      const imageInputs = normalizeReferenceImages(params);
      const filename = readStringParam(params, "filename");
      const size = readStringParam(params, "size");
      const aspectRatio = normalizeAspectRatio(readStringParam(params, "aspectRatio"));
      const explicitResolution = normalizeResolution(readStringParam(params, "resolution"));
      const timeoutMs = readGenerationTimeoutMs(params) ?? imageGenerationModelConfig.timeoutMs;
      const quality = normalizeQuality(readStringParam(params, "quality"));
      const outputFormat = normalizeOutputFormat(readStringParam(params, "outputFormat"));
      const background = normalizeBackground(readStringParam(params, "background"));
      const providerOptions = normalizeProviderOptions(params);
      const selectedProvider = resolveSelectedImageGenerationProvider({
        config: effectiveCfg,
        imageGenerationModelConfig,
        modelOverride: model,
      });
      const explicitModelRef = parseImageGenerationModelRef(model);
      const primaryModelRef = parseImageGenerationModelRef(imageGenerationModelConfig.primary);
      const selectedModelId = resolveSelectedImageGenerationModelId({
        selectedProvider,
        imageGenerationModelConfig,
        modelOverride: model,
        explicitModelRef,
        primaryModelRef,
      });
      const count = resolveRequestedCount(params);
      const requestKey = buildMediaGenerationRequestKey({
        tool: "image_generate",
        prompt,
        provider: selectedProvider?.id ?? explicitModelRef?.provider ?? primaryModelRef?.provider,
        model:
          model !== undefined
            ? (explicitModelRef?.model ?? model)
            : (primaryModelRef?.model ??
              imageGenerationModelConfig.primary ??
              selectedProvider?.defaultModel),
        count,
        imageInputs,
        size,
        aspectRatio,
        resolution: explicitResolution,
        quality,
        outputFormat,
        background,
        filename,
        providerOptions,
      });
      const duplicateGuardResult = createImageGenerateDuplicateGuardResult(
        options?.agentSessionKey,
        { prompt, requestKey },
      );
      if (duplicateGuardResult) {
        return duplicateGuardResult;
      }
      validateImageGenerationCapabilities({
        provider: selectedProvider,
        count,
        inputImageCount: imageInputs.length,
        size,
        aspectRatio,
        resolution: explicitResolution,
        explicitResolution: Boolean(explicitResolution),
      });
      const configuredMediaMaxBytes = resolveConfiguredMediaMaxBytes(effectiveCfg);
      const loadedReferenceImages = await loadReferenceImages({
        imageInputs,
        maxBytes: configuredMediaMaxBytes,
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
        ssrfPolicy: remoteMediaSsrfPolicy,
      });
      const inputImages = loadedReferenceImages.map((entry) => entry.sourceImage);
      const modeCaps =
        inputImages.length > 0
          ? selectedProvider?.capabilities.edit
          : selectedProvider?.capabilities.generate;
      const suppressInferredResolution =
        inputImages.length > 0 &&
        !explicitResolution &&
        isFalKreaImageModel(selectedProvider, selectedModelId);
      const resolution =
        explicitResolution ??
        (size || suppressInferredResolution || modeCaps?.supportsResolution === false
          ? undefined
          : inputImages.length > 0
            ? await inferResolutionFromInputImages(inputImages)
            : undefined);
      validateImageGenerationCapabilities({
        provider: selectedProvider,
        count,
        inputImageCount: inputImages.length,
        size,
        aspectRatio,
        resolution,
        explicitResolution: Boolean(explicitResolution),
      });
      const taskHandle = createImageGenerationTaskRun({
        sessionKey: options?.agentSessionKey,
        requesterOrigin: options?.requesterOrigin,
        prompt,
        providerId: selectedProvider?.id,
      });
      const shouldDetach = Boolean(
        taskHandle && shouldDetachMediaGenerationTask(options?.agentSessionKey),
      );

      if (shouldDetach && taskHandle) {
        recordRecentMediaGenerationTaskStartForSession({
          sessionKey: options?.agentSessionKey,
          taskKind: "image_generation",
          sourcePrefix: "image_generate",
          taskId: taskHandle.taskId,
          runId: taskHandle.runId,
          taskLabel: prompt,
          requestKey,
          providerId: selectedProvider?.id,
          progressSummary: "Generating image",
        });
        scheduleMediaGenerationTaskCompletion({
          lifecycle: imageGenerationTaskLifecycle,
          handle: taskHandle,
          scheduleBackgroundWork,
          progressSummary: "Generating image",
          config: effectiveCfg,
          toolName: "Image generation",
          onWakeFailure: (message, meta) => log.warn(message, meta),
          run: () =>
            executeImageGenerationJob({
              effectiveCfg,
              prompt,
              agentDir: options?.agentDir,
              model,
              size,
              aspectRatio,
              resolution,
              quality,
              outputFormat,
              background,
              count,
              inputImages,
              timeoutMs,
              providerOptions,
              ssrfPolicy: remoteMediaSsrfPolicy,
              filename,
              loadedReferenceImages,
              taskHandle,
              autoProviderFallback: explicitModelConfig ? false : undefined,
            }),
        });

        await notifyMediaGenerationAsyncTaskStarted({
          callback: options?.onAsyncTaskStarted,
          message: "Image generation started; wait for the generated image completion event.",
          toolName: "image_generate",
          handle: taskHandle,
          onFailure: (message, meta) => log.warn(message, meta),
        });

        return buildMediaGenerationStartedToolResult({
          toolName: "image_generate",
          generationLabel: "image",
          completionLabel: "image",
          taskHandle,
          detailExtras: {
            ...buildMediaReferenceDetails({
              entries: loadedReferenceImages,
              singleKey: "image",
              pluralKey: "images",
              getResolvedInput: (entry) => entry.resolvedImage,
            }),
            ...(model ? { model } : {}),
            ...(resolution ? { resolution } : {}),
            ...(size ? { size } : {}),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(quality ? { quality } : {}),
            ...(outputFormat ? { outputFormat } : {}),
            ...(background ? { background } : {}),
            ...(filename ? { filename } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          },
        });
      }

      try {
        const executed = await executeImageGenerationJob({
          effectiveCfg,
          prompt,
          agentDir: options?.agentDir,
          model,
          size,
          aspectRatio,
          resolution,
          quality,
          outputFormat,
          background,
          count,
          inputImages,
          timeoutMs,
          providerOptions,
          ssrfPolicy: remoteMediaSsrfPolicy,
          filename,
          loadedReferenceImages,
          taskHandle,
          autoProviderFallback: explicitModelConfig ? false : undefined,
        });
        completeImageGenerationTaskRun({
          handle: taskHandle,
          provider: executed.provider,
          model: executed.model,
          count: executed.count,
          paths: executed.paths,
        });
        return {
          content: [{ type: "text", text: executed.contentText }],
          details: executed.details,
        };
      } catch (error) {
        failImageGenerationTaskRun({
          handle: taskHandle,
          error,
        });
        throw error;
      }
    },
  };
}
