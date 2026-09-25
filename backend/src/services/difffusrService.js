const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

const PYTHON_BIN = path.resolve(__dirname, '../../../.venv/bin/python');
const SCRIPT_PATH = path.resolve(__dirname, 'difffusr_inference.py');

let daemonProcess = null;
let daemonReady = false;
let pendingQueue = [];
let activeTask = null;
let modelStatus = {
  ready: false,
  model: 'DiffFuSR',
  device: 'Detecting...',
};

function ensureDiffFuSRDaemon() {
  if (daemonProcess && !daemonProcess.killed) {
    return;
  }

  const pythonPath = fs.existsSync(PYTHON_BIN) ? PYTHON_BIN : 'python3';

  daemonProcess = spawn(pythonPath, [SCRIPT_PATH, '--daemon'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONPATH: `/home/kshrs/DiffFuSR:/home/kshrs/DiffFuSR/litsr:${process.env.PYTHONPATH || ''}`,
    },
  });

  daemonReady = false;

  const rl = readline.createInterface({ input: daemonProcess.stdout });

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line.trim());
      if (msg.status === 'ready') {
        daemonReady = true;
        modelStatus = {
          ready: true,
          model: msg.model || 'DiffFuSR',
          device: msg.device || 'CPU',
        };
        console.log(`[DiffFuSR Service] Daemon online. Model: ${modelStatus.model} on ${modelStatus.device}`);
        processNext();
      } else if (activeTask) {
        const { resolve, reject } = activeTask;
        activeTask = null;
        if (msg.status === 'ok') {
          resolve(msg.out);
        } else {
          reject(new Error(msg.error || 'DiffFuSR daemon inference error'));
        }
        processNext();
      }
    } catch (err) {
      console.error('[DiffFuSR Daemon] Error parsing line:', line, err);
      if (activeTask) {
        activeTask.reject(err);
        activeTask = null;
      }
      processNext();
    }
  });

  daemonProcess.stderr.on('data', (data) => {
    process.stdout.write(`\x1b[35m${data.toString()}\x1b[0m`);
  });

  daemonProcess.on('exit', (code) => {
    console.warn(`[DiffFuSR Daemon] Exited with code ${code}`);
    daemonProcess = null;
    daemonReady = false;
    modelStatus.ready = false;
    if (activeTask) {
      activeTask.reject(new Error(`DiffFuSR daemon exited unexpectedly with code ${code}`));
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
 * Super-resolves an input tile file to an output tile file via persistent DiffFuSR daemon
 */
function superResolveDiffFuSRTileFile(inPath, outPath) {
  return new Promise((resolve, reject) => {
    ensureDiffFuSRDaemon();
    pendingQueue.push({ inPath, outPath, resolve, reject });
    if (daemonReady && !activeTask) {
      processNext();
    }
  });
}

function getDiffFuSRStatus() {
  return { ...modelStatus };
}

module.exports = {
  superResolveDiffFuSRTileFile,
  getDiffFuSRStatus,
  ensureDiffFuSRDaemon,
};
