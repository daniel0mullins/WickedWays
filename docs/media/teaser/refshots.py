import os, pathlib
from playwright.sync_api import sync_playwright
HERE = pathlib.Path("/home/user/WickedWays/docs/media/teaser")
OUT = pathlib.Path(os.environ.get("REF_OUT", HERE / "reference-frames")); OUT.mkdir(parents=True, exist_ok=True)
for f in OUT.glob("*.png"): f.unlink()
SHOTS = [
 ("s1-a", 2.6), ("s1-b", 4.6), ("s2-a", 7.4), ("s2-b", 9.9),
 ("s3-a", 12.6), ("s3-b", 14.9), ("s4-a", 18.2), ("s4-b", 20.4),
 ("s5-a", 25.0), ("s5-b", 27.2), ("s6-a", 30.4), ("s6-b", 32.6),
 ("s7-a", 35.0), ("s7-b", 37.0),
]
with sync_playwright() as pw:
    b = pw.chromium.launch(**({"executable_path": os.environ["CHROMIUM_PATH"]} if os.environ.get("CHROMIUM_PATH") else {}),
        args=["--force-color-profile=srgb","--font-render-hinting=none","--disable-lcd-text","--hide-scrollbars"])
    pg = b.new_page(viewport={"width":1280,"height":720}, device_scale_factor=1.5)  # -> 1920x1080
    pg.goto((HERE/"teaser.html").as_uri()); pg.wait_for_timeout(700)
    for name, t in SHOTS:
        pg.evaluate("t => window.renderFrame(t)", t)
        pg.screenshot(path=str(OUT/f"{name}.png"), type="png")
    b.close()
print("rendered", len(SHOTS), "reference frames at 1920x1080")
