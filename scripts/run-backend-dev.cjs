/**
 * Запуск uvicorn из backend/venv (Windows: venv\Scripts\python.exe, Unix: venv/bin/python).
 * Нужен для npm run backend:dev на Windows — в package.json нельзя надёжно вызвать venv/bin/activate.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const backend = path.join(root, "backend");
const isWin = process.platform === "win32";
const py = isWin
  ? path.join(backend, "venv", "Scripts", "python.exe")
  : path.join(backend, "venv", "bin", "python");

if (!fs.existsSync(py)) {
  console.error(
    "[Simulex] Не найден интерпретатор venv:",
    py,
    "\nСоздайте окружение: python -m venv backend\\venv затем pip install -r backend\\requirements.txt"
  );
  process.exit(1);
}

function readBackendEnvPort() {
  const envPath = path.join(backend, ".env");
  if (!fs.existsSync(envPath)) return null;
  try {
    const text = fs.readFileSync(envPath, "utf8");
    const m = text.match(/^\s*PORT\s*=\s*(\d+)\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const noReload = process.argv.includes("--no-reload");
const apiPort =
  process.env.BACKEND_DEV_PORT ||
  readBackendEnvPort() ||
  "5000";
const uvicornArgs = ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", apiPort];
if (!noReload) {
  uvicornArgs.splice(3, 0, "--reload");
}

const child = spawn(py, uvicornArgs, {
  cwd: backend,
  stdio: "inherit",
  shell: false,
  env: { ...process.env },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
