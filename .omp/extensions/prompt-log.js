import logPrompt from "../../.claude/log-prompt.cjs";

export default function (omp) {
  omp.on("input", (event) => {
    logPrompt("omp", event.text);
  });
}
