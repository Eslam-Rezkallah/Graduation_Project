import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, "analytics_ai_service.py");

function resolvePythonBin() {
  const configured = process.env.AI_PYTHON_PATH;
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.join(process.cwd(), configured);
  }
  return "python3";
}

function runPython(command, payload) {
  return new Promise((resolve) => {
    const py = spawn(resolvePythonBin(), [SCRIPT_PATH, command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    py.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    py.on("close", () => {
      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch {
        resolve({
          aiUsed: false,
          aiModel: "python-analytics-v1",
          aiFallbackReason: stderr || "Invalid response from Python analytics service",
        });
      }
    });

    py.on("error", (err) => {
      resolve({
        aiUsed: false,
        aiModel: "python-analytics-v1",
        aiFallbackReason: err?.message || "Failed to start Python analytics service",
      });
    });

    py.stdin.write(JSON.stringify(payload || {}));
    py.stdin.end();
  });
}

export async function predictSprintCompletionAI(payload) {
  return runPython("sprint_completion", payload);
}

export async function detectBottlenecksAI(payload) {
  return runPython("bottleneck_detection", payload);
}
