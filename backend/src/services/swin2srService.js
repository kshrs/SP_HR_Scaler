const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const PYTHON_BIN = path.resolve(__dirname, '../../../.venv/bin/python');
const SCRIPT_PATH = path.resolve(__dirname, 'swin2sr_inference.py');

let daemonProcess = null;
let daemonReady = false;
let pendingQueue = [];
let activeTask = null;

function ensureDaemon() {
  if (daemonProcess && !daemonProcess.killed) {
    return;
  }

  // Check if python venv exists
  const pythonPath = fs.existsSync(PYTHON_BIN) ? PYTHON_BIN : 'python3';

  daemonProcess = spawn(pythonPath, [SCRIPT_PATH, '--daemon'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  daemonReady = false;

  const rl = readline.createInterface({ input: daemonProcess.stdout });

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line.trim());
      if (msg.status === 'ready') {
        daemonReady = true;
        processNext();
      } else if (activeTask) {
        const { resolve, reject } = activeTask;
        activeTask = null;
        if (msg.status === 'ok') {
          resolve(msg.out);
        } else {
          reject(new Error(msg.error || 'Daemon inference error'));
        }
        processNext();
      }
    } catch (err) {
      console.error('[Swin2SR Daemon] Failed parsing response line:', line, err);
      if (activeTask) {
        activeTask.reject(err);
        activeTask = null;
      }
      processNext();
    }
  });

  daemonProcess.stderr.on('data', (data) => {
    console.warn(`[Swin2SR Daemon stderr]: ${data.toString()}`);
  });

  daemonProcess.on('exit', (code) => {
    console.warn(`[Swin2SR Daemon] Exited with code ${code}`);
    daemonProcess = null;
    daemonReady = false;
    if (activeTask) {
      activeTask.reject(new Error(`Swin2SR daemon exited unexpectedly with code ${code}`));
      activeTask = null;
    }
  });
}

function processNext() {
  if (!daemonReady || activeTask || pendingQueue.length === 0) {
    return;
  }
  activeTask = pendingQueue.shift();
  try {
    const payload = JSON.stringify({ in: activeTask.inPath, out: activeTask.outPath }) + '\n';
    daemonProcess.stdin.write(payload);
  } catch (err) {
    activeTask.reject(err);
    activeTask = null;
    processNext();
  }
}

/**
 * Super-resolves an input tile file to an output tile file via persistent ONNX Swin2SR daemon
 */
function superResolveTileFile(inPath, outPath) {
  return new Promise((resolve, reject) => {
    ensureDaemon();
    pendingQueue.push({ inPath, outPath, resolve, reject });
    if (daemonReady && !activeTask) {
      processNext();
    }
  });
}

module.exports = {
  superResolveTileFile,
};
