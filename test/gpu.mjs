// System Chrome with ANGLE Metal in a fresh headless profile; never open a GUI or a user browser profile.
import { chromium } from "playwright-core";
export const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const LOCAL_ONLY = ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--no-proxy-server"];
const GPU_ARGS = [...LOCAL_ONLY, ...(process.env.PA_UNCAPPED ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : []), "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan"];
export const hardwareRenderer = (name) => !!name && !/unknown|unavailable|swiftshader|llvmpipe|software/i.test(name);
export async function rendererOf(page) { return page.evaluate(() => { const c = document.createElement("canvas"), gl = c.getContext("webgl2"); const e = gl && gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : (gl ? "unknown" : "unavailable"); }); }
export async function launchGpu({ width = 1280, height = 800 } = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: GPU_ARGS });
  try {
    const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
    return { browser, page, renderer: await rendererOf(page), mode: "headless" };
  } catch (error) { await browser.close(); throw error; }
}
