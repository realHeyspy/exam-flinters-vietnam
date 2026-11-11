import logPrompt from "../../.claude/log-prompt.cjs";

// Export directly: OpenCode 2.0.18 cannot resolve the optional SDK import.
export default {
  id: "prompt-log",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      logPrompt("OpenCode", event.prompt.text);
    });
  },
};
