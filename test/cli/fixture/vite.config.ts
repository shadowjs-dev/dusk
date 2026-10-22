import { node } from "@shadow-js/dusk/node";
import { dusk } from "@shadow-js/dusk/vite";
import type { UserConfig } from "vite";

const config: UserConfig = {
  plugins: [dusk({ adapter: node() })],
};

export default config;
