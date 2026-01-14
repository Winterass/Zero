import type { MailManager, ManagerConfig } from './types';
import { IMAPMailManager } from './imap';

const supportedProviders = {
  imap: IMAPMailManager,
};

export const createDriver = (
  provider: keyof typeof supportedProviders | (string & {}),
  config: ManagerConfig,
): MailManager => {
  const Provider = supportedProviders[provider as keyof typeof supportedProviders];
  if (!Provider) throw new Error('Provider not supported');
  return new Provider(config);
};
