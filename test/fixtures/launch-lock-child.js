import {
  acquireLaunchLock,
  releaseLaunchLock,
} from '../../bin/pan-runner-runtime.js';

let lock = null;

process.on('message', async (message) => {
  if (message?.type === 'start') {
    try {
      lock = await acquireLaunchLock(message.panDir, {
        checkpoint: async (boundary) => {
          if (boundary === message.pauseAt) {
            process.send?.({ type: 'paused', boundary });
            await new Promise(() => {});
          }
        },
      });
      process.send?.({ type: 'acquired', token: lock.token });
    } catch (error) {
      process.send?.({ type: 'failed', error: error.message });
      process.disconnect?.();
    }
    return;
  }

  if (message?.type === 'release' && lock) {
    await releaseLaunchLock(lock);
    process.send?.({ type: 'released' });
    process.exit(0);
  }
});
