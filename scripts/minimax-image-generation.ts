const MINIMAX_IMAGE_ENDPOINTS = {
  global_en: "https://api.minimax.io/v1/image_generation",
  cn_zh: "https://api.minimaxi.com/v1/image_generation",
} as const;

const MINIMAX_IMAGE_MODELS = ["image-01", "image-01-live"] as const;
const MINIMAX_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "4:3",
  "3:2",
  "2:3",
  "3:4",
  "9:16",
  "21:9",
] as const;

export type MiniMaxImageRegion = keyof typeof MINIMAX_IMAGE_ENDPOINTS;
export type MiniMaxImageModel = (typeof MINIMAX_IMAGE_MODELS)[number];
export type MiniMaxImageAspectRatio =
  (typeof MINIMAX_IMAGE_ASPECT_RATIOS)[number];
export type MiniMaxImageResponseFormat = "url" | "base64";

export type MiniMaxSubjectReference = {
  type: "character";
  image_file: string;
};

export type MiniMaxImageToImageRequest = {
  model: MiniMaxImageModel;
  prompt: string;
  subject_reference: MiniMaxSubjectReference[];
  aspect_ratio?: MiniMaxImageAspectRatio;
  width?: number;
  height?: number;
  response_format?: MiniMaxImageResponseFormat;
  seed?: number;
  n?: number;
  prompt_optimizer?: boolean;
};

export type MiniMaxImageGenerationResponse = {
  id?: string;
  data: {
    image_urls?: string[];
    image_base64?: string[];
  };
  metadata: {
    success_count: number | string;
    failed_count: number | string;
  };
  base_resp: {
    status_code: number;
    status_msg?: string;
  };
};

export class MiniMaxImageGenerationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MiniMaxImageGenerationError";
  }
}

type MiniMaxImageGenerationOptions = {
  apiKey?: string;
  region?: MiniMaxImageRegion;
  fetch?: typeof fetch;
};

function resolveRegion(value: string | undefined): MiniMaxImageRegion {
  const region = value || "global_en";
  if (region !== "global_en" && region !== "cn_zh") {
    throw new MiniMaxImageGenerationError(
      "MINIMAX_REGION must be global_en or cn_zh",
      500,
    );
  }
  return region;
}

function validateDimension(value: number, name: "width" | "height") {
  if (!Number.isInteger(value) || value < 512 || value > 2048 || value % 8) {
    throw new MiniMaxImageGenerationError(
      `${name} must be an integer from 512 to 2048 divisible by 8`,
      400,
    );
  }
}

export function validateMiniMaxImageToImageRequest(
  request: MiniMaxImageToImageRequest,
) {
  if (!MINIMAX_IMAGE_MODELS.includes(request.model)) {
    throw new MiniMaxImageGenerationError(
      "model must be image-01 or image-01-live",
      400,
    );
  }
  if (!request.prompt?.trim() || request.prompt.length > 1500) {
    throw new MiniMaxImageGenerationError(
      "prompt must contain 1 to 1500 characters",
      400,
    );
  }
  if (!request.subject_reference?.length) {
    throw new MiniMaxImageGenerationError(
      "subject_reference must contain at least one image",
      400,
    );
  }
  for (const reference of request.subject_reference) {
    if (reference.type !== "character") {
      throw new MiniMaxImageGenerationError(
        "subject_reference.type must be character",
        400,
      );
    }
    let referenceUrl: URL;
    try {
      referenceUrl = new URL(reference.image_file);
    } catch {
      throw new MiniMaxImageGenerationError(
        "subject_reference.image_file must be a public URL",
        400,
      );
    }
    if (
      referenceUrl.protocol !== "https:" &&
      referenceUrl.protocol !== "http:"
    ) {
      throw new MiniMaxImageGenerationError(
        "subject_reference.image_file must be a public URL",
        400,
      );
    }
  }
  if (
    request.aspect_ratio &&
    !MINIMAX_IMAGE_ASPECT_RATIOS.includes(request.aspect_ratio)
  ) {
    throw new MiniMaxImageGenerationError("Invalid aspect_ratio", 400);
  }
  if ((request.width === undefined) !== (request.height === undefined)) {
    throw new MiniMaxImageGenerationError(
      "width and height must be provided together",
      400,
    );
  }
  if (request.width !== undefined && request.height !== undefined) {
    validateDimension(request.width, "width");
    validateDimension(request.height, "height");
  }
  if (
    request.response_format &&
    request.response_format !== "url" &&
    request.response_format !== "base64"
  ) {
    throw new MiniMaxImageGenerationError(
      "response_format must be url or base64",
      400,
    );
  }
  if (
    request.n !== undefined &&
    (!Number.isInteger(request.n) || request.n < 1 || request.n > 9)
  ) {
    throw new MiniMaxImageGenerationError("n must be from 1 to 9", 400);
  }
  if (request.seed !== undefined && !Number.isInteger(request.seed)) {
    throw new MiniMaxImageGenerationError("seed must be an integer", 400);
  }
}

function isMiniMaxImageGenerationResponse(
  value: unknown,
): value is MiniMaxImageGenerationResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<MiniMaxImageGenerationResponse>;
  return (
    !!response.data &&
    !!response.metadata &&
    !!response.base_resp &&
    typeof response.base_resp.status_code === "number"
  );
}

export async function generateMiniMaxImage(
  request: MiniMaxImageToImageRequest,
  options: MiniMaxImageGenerationOptions = {},
): Promise<MiniMaxImageGenerationResponse> {
  const apiKey = options.apiKey || process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    throw new MiniMaxImageGenerationError(
      "MINIMAX_API_KEY is not configured",
      500,
    );
  }
  const region = options.region || resolveRegion(process.env.MINIMAX_REGION);
  validateMiniMaxImageToImageRequest(request);

  const response = await (options.fetch || fetch)(
    MINIMAX_IMAGE_ENDPOINTS[region],
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    },
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MiniMaxImageGenerationError(
      "MiniMax returned an invalid JSON response",
      response.ok ? 502 : response.status,
    );
  }
  if (!response.ok) {
    throw new MiniMaxImageGenerationError(
      "MiniMax image generation request failed",
      response.status,
    );
  }
  if (!isMiniMaxImageGenerationResponse(payload)) {
    throw new MiniMaxImageGenerationError(
      "MiniMax returned an invalid image generation response",
      502,
    );
  }
  if (payload.base_resp.status_code !== 0) {
    throw new MiniMaxImageGenerationError(
      payload.base_resp.status_msg || "MiniMax image generation request failed",
      502,
    );
  }

  const images =
    request.response_format === "base64"
      ? payload.data.image_base64 || payload.data.image_urls
      : payload.data.image_urls;
  if (!images?.length) {
    throw new MiniMaxImageGenerationError(
      "MiniMax returned no generated images",
      502,
    );
  }
  return payload;
}

export async function generateMiniMaxReferenceImageFromEnv(
  prompt: string,
  aspectRatio: MiniMaxImageAspectRatio,
): Promise<Buffer | null> {
  const imageFile = process.env.MINIMAX_SUBJECT_REFERENCE_URL;
  if (!imageFile) return null;

  const response = await generateMiniMaxImage({
    model: "image-01",
    prompt,
    subject_reference: [{ type: "character", image_file: imageFile }],
    aspect_ratio: aspectRatio,
    response_format: "base64",
    n: 1,
    prompt_optimizer: false,
  });
  const encoded =
    response.data.image_base64?.[0] || response.data.image_urls?.[0];
  if (!encoded) {
    throw new MiniMaxImageGenerationError(
      "MiniMax returned no generated image data",
      502,
    );
  }
  const base64 = encoded.startsWith("data:")
    ? encoded.slice(encoded.indexOf(",") + 1)
    : encoded;
  return Buffer.from(base64, "base64");
}
