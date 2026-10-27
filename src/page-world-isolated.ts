// page-world-isolated.ts — marks the bundle it is imported into as the isolated world's, before anything else in it runs.

import { pageWorld } from "./page-world";

pageWorld.isolated = true;
