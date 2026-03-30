import { defineCommand } from "citty";
import { generateAiGuideWithHeader } from "../docs/ai-guide";

export const aiDocsCommand = defineCommand({
  meta: {
    name: "ai-docs",
    description: "Show documentation for AI coding agents",
  },
  args: {},
  run() {
    // Output markdown directly to stdout for easy piping/reading by AI agents
    console.log(generateAiGuideWithHeader());
  },
});
