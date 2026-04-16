export const evaluateDeviceCapabilities = async () => {
  const cores = navigator.hardwareConcurrency || 2; // Default to 2 if unknown
  const memory = navigator.deviceMemory || 2; // Default to 2GB if unknown
  
  // OS Detection
  let os = "Unknown";
  if (navigator.userAgent.indexOf("Win") !== -1) os = "Windows";
  if (navigator.userAgent.indexOf("Mac") !== -1) os = "MacOS";
  if (navigator.userAgent.indexOf("X11") !== -1) os = "UNIX";
  if (navigator.userAgent.indexOf("Linux") !== -1) os = "Linux";

  // Extremely basic FPS measuring using requestAnimationFrame for ~500ms
  const measureFPS = () => {
    return new Promise((resolve) => {
      let frames = 0;
      let startTime = performance.now();
      
      const tick = () => {
        frames++;
        if (performance.now() - startTime >= 500) {
          resolve(frames * 2); // Extrapolate to 1 second
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  };

  const fps = await measureFPS();

  const deviceInfo = {
    cores,
    memory,
    fps,
    os,
  };

  let tier = "full";
  if (cores < 2 || memory < 2) {
    tier = "event-only";
  } else if (cores < 4 || memory < 4 || fps < 30) {
    tier = "snapshot";
  }

  return { deviceInfo, tier };
};
