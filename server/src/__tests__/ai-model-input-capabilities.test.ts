import { describe, expect, it, vi } from "vitest";
import { aiProviderRoutingSchema } from "@paperclipai/shared";
import { managedModelVision } from "../services/ai-model-input-capabilities.js";
import { managedProviderRouting } from "../services/ai-provider-routing.js";

const route = aiProviderRoutingSchema.parse({kind:"gateway",protocol:"chat",baseUrl:"https://router.example/v1"});
describe("managed model image input", () => {
  it.each([true,false])("projects advertised vision=%s without changing routing or credentials", async vision => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({data:[{id:"medium",capabilities:{vision}}]}));
    const actual = await managedModelVision(route,`key-${vision}`,"paperclip/medium",request);
    expect(actual).toBe(vision);
    expect(request.mock.calls[0][0]).toBe("https://router.example/v1/models");
    expect(request.mock.calls[0][1]).toMatchObject({redirect:"error",headers:{Authorization:`Bearer key-${vision}`}});
    const projected = managedProviderRouting(route,"opencode_local",`key-${vision}`,"paperclip/medium",actual);
    const provider = JSON.parse(projected.env.OPENCODE_CONFIG_CONTENT).provider.paperclip;
    expect(provider.models.medium.modalities).toEqual({input:vision?["text","image"]:["text"],output:["text"]});
    expect(provider.options.baseURL).toBe(route.baseUrl);
    expect(provider.options.apiKey).toBe(`key-${vision}`);
  });
  it("does not invent capabilities for unknown models or failed discovery", async () => {
    for (const [key, response] of [["missing",Response.json({data:[]})],["failure",new Response("unavailable",{status:503})],["invalid",new Response("invalid")]] as const) {
      const request = vi.fn<typeof fetch>().mockResolvedValue(response);
      const vision = await managedModelVision(route,key,"paperclip/unknown",request);
      expect(vision).toBeUndefined();
      const provider=JSON.parse(managedProviderRouting(route,"opencode_local",key,"paperclip/unknown",vision).env.OPENCODE_CONFIG_CONTENT).provider.paperclip;
      expect(provider.models.unknown).toEqual({name:"unknown"});
    }
  });
  it("caches by account and model, and omits auth for anonymous local endpoints", async () => {
    const local=aiProviderRoutingSchema.parse({kind:"local",protocol:"chat",auth:"none",baseUrl:"http://localhost:11434/v1"});
    const request=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({data:[{id:"vision",input_modalities:["text","image"]}]}));
    expect(await managedModelVision(local,"","vision",request)).toBe(true);
    expect(await managedModelVision(local,"","vision",request)).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.headers).toEqual({});
    await managedModelVision(local,"","other",request);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("bounds discovery and does not follow redirects", async () => {
    const request=vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(2*1024*1024+1)));
    expect(await managedModelVision(route,"oversize","medium",request)).toBeUndefined();
    const opts=request.mock.calls[0][1];
    expect(opts?.redirect).toBe("error");
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });
});
