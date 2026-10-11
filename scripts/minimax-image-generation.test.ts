import { describe, expect, test } from "bun:test";

import {
  generateMiniMaxImage,
  MiniMaxImageGenerationError,
  validateMiniMaxImageToImageRequest,
} from "./minimax-image-generation";

const request = {
  model: "image-01" as const,
  prompt: "Keep the character recognizable in a new scene",
  subject_reference: [
    {
      type: "character" as const,
      image_file: "https://example.com/reference.png",
    },
  ],
  aspect_ratio: "1:1" as const,
  response_format: "url" as const,
};

describe("MiniMax image generation", () => {
  test("validates image-to-image inputs", () => {
    expect(() => validateMiniMaxImageToImageRequest(request)).not.toThrow();
    expect(() =>
      validateMiniMaxImageToImageRequest({
        ...request,
        subject_reference: [],
      }),
    ).toThrow(MiniMaxImageGenerationError);
    expect(() =>
      validateMiniMaxImageToImageRequest({
        ...request,
        width: 1024,
      }),
    ).toThrow("width and height");
  });

  test("posts to the selected regional endpoint", async () => {
    let requestedUrl = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      requestedUrl = input.toString();
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-key",
      );
      expect(JSON.parse(init?.body as string).subject_reference).toEqual(
        request.subject_reference,
      );
      return Response.json({
        data: { image_urls: ["https://example.com/generated.png"] },
        metadata: { success_count: "1", failed_count: "0" },
        base_resp: { status_code: 0, status_msg: "success" },
      });
    };

    const response = await generateMiniMaxImage(request, {
      apiKey: "test-key",
      region: "cn_zh",
      fetch: fetchImpl,
    });

    expect(requestedUrl).toBe("https://api.minimaxi.com/v1/image_generation");
    expect(response.data.image_urls).toHaveLength(1);
  });

  test("accepts base64 image responses", async () => {
    const response = await generateMiniMaxImage(
      { ...request, response_format: "base64" },
      {
        apiKey: "test-key",
        fetch: async (input) => {
          expect(input.toString()).toBe(
            "https://api.minimax.io/v1/image_generation",
          );
          return Response.json({
            data: { image_base64: ["aW1hZ2U="] },
            metadata: { success_count: 1, failed_count: 0 },
            base_resp: { status_code: 0 },
          });
        },
      },
    );

    expect(response.data.image_base64).toEqual(["aW1hZ2U="]);
  });

  test("rejects an unsuccessful API response", async () => {
    await expect(
      generateMiniMaxImage(request, {
        apiKey: "test-key",
        fetch: async () =>
          Response.json({
            data: {},
            metadata: { success_count: 0, failed_count: 1 },
            base_resp: { status_code: 1001, status_msg: "Invalid request" },
          }),
      }),
    ).rejects.toThrow("Invalid request");
  });
});
