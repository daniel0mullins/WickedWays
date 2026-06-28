import type { PlaySurface, MountArgs, SurfaceHandle } from "@wickedways/play-runtime";
import { defaultCrtTheme } from "./theme.js";
import { mountTerminal } from "./controller.js";

export const crtSurface: PlaySurface = {
  id: "crt-terminal",
  label: "CRT Terminal",
  defaultTheme: defaultCrtTheme,
  mount(args: MountArgs): SurfaceHandle {
    return mountTerminal(args.app, args.session, {
      title: args.manifest.title,
      intro: args.manifest.intro,
      buttonText: args.manifest.buttonText,
      audio: args.audio,
      themes: args.themes,
      onExit: args.onExit,
      initialThemeId: args.initialThemeId,
      onThemeChange: args.onThemeChange,
    });
  },
};
