import { themeController } from "../../themes/core/index.ts";
import { createLightingController } from "./controller.ts";

/** The app-wide lighting controller. It drives the app-wide theme controller's day or night. */
export const lightingController = createLightingController({ theme: themeController });
