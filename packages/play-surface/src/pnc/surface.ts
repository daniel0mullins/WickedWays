import type { PlaySurface, MountArgs, SurfaceHandle } from "@wickedways/play-runtime";
import { defaultPncTheme } from "./theme.js";
import { mountPointAndClick } from "./controller.js";

export const pncSurface: PlaySurface = {
  id: "point-and-click",
  label: "Point & Click",
  description: "Point-and-click scene",
  defaultTheme: defaultPncTheme,
  mount(args: MountArgs): SurfaceHandle {
    return mountPointAndClick(args.app, args.session, {
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
