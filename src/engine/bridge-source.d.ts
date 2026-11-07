// bridge/bridge.py is bundled into main.js as a string via esbuild's
// ".py": "text" loader (see esbuild.config.mjs).
declare module "*.py" {
  const source: string;
  export default source;
}
