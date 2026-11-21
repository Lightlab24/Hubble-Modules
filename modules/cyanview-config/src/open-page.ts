import { createModuleHelperClient, type ModuleHostServices } from '@hubble/module-sdk';
import { object, validIp } from './model.js';

/** Opens a controller's own web page in the browser, on the computer Hubble runs on. */
export type OpenDevicePage = (address: string, signal: AbortSignal) => Promise<void>;

/**
 * A module page can't open a browser itself: Hubble shows it in a frame that may not open windows. So the
 * module's own helper, which already runs the ping tool, starts the browser.
 */
export function createHostOpenPage(services: ModuleHostServices): OpenDevicePage {
  const helper = createModuleHelperClient(services, 'icmp-probe');
  return async (address, signal) => {
    if (!validIp(address)) throw new Error('Enter a valid IPv4 address');
    const status = await helper.start(signal);
    if (status.status !== 'helper' || status.state !== 'ready') throw new Error((status.status === 'helper' ? status.message : null) || 'The browser can’t be opened from here. Type the address into a browser.');
    const result = object(await helper.call('open-page', { address }, signal));
    if (result.opened !== 'http://' + address + '/') throw new Error('The browser could not be opened');
  };
}
