// Called by the desktop launcher: Hyprland does not always start graphical-session.target.
import { execFileSync } from 'node:child_process';

export function ensurePenBridge({ env = process.env, run = execFileSync, warn = console.error } = {}) {
  if (!env.DISPLAY || !env.HYPRLAND_INSTANCE_SIGNATURE || !env.XDG_RUNTIME_DIR) return false;
  const names = ['DISPLAY', 'WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE', 'XDG_RUNTIME_DIR', 'XAUTHORITY']
    .filter(name => env[name]);
  const systemctl = '/run/current-system/sw/bin/systemctl';
  try {
    run(systemctl, ['--user', 'import-environment', ...names], { env, stdio: 'pipe', timeout: 3000 });
    // Restart also repairs a bridge left attached to a previous desktop session.
    run(systemctl, ['--user', 'restart', 'notesgood-pen.service'], { env, stdio: 'pipe', timeout: 5000 });
    return true;
  } catch {
    // Pen support must not prevent opening the notebook library.
    warn('Notesgood: pen buttons could not be started; check notesgood-pen.service.');
    return false;
  }
}
