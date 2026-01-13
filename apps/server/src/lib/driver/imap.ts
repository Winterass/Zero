import {
  deleteActiveConnection,
  FatalErrors,
  sanitizeContext,
  StandardizedError,
} from './utils';
import type { IOutgoingMessage, Label, ParsedMessage, DeleteAllSpamResponse } from '../../types';
import { sanitizeTipTapHtml } from '../sanitize-tip-tap-html';
import type { MailManager, ManagerConfig, ParsedDraft, IGetThreadResponse } from './types';
import type { CreateDraftData } from '../schemas';
import { createMimeMessage } from 'mimetext';
import * as Imap from 'imap';
import * as nodemailer from 'nodemailer';
import { simpleParser, ParsedMail } from 'mailparser';

export class IMAPMailManager implements MailManager {
  private imapConnection: Imap | null = null;
  private smtpTransporter: nodemailer.Transporter | null = null;
  private labelCache: Map<string, string> = new Map();
  private folderCache: Map<string, string[]> = new Map();

  constructor(public config: ManagerConfig) {
    if (!config.imapConfig) {
      throw new Error('IMAP configuration is required for IMAP provider');
    }
  }

  private async getImapConnection(): Promise<Imap> {
    if (!this.config.imapConfig) {
      throw new Error('IMAP configuration is required');
    }

    if (this.imapConnection) {
      return this.imapConnection;
    }

    const imap = new Imap({
      user: this.config.imapConfig.user,
      password: this.config.imapConfig.password,
      host: this.config.imapConfig.host,
      port: this.config.imapConfig.port,
      tls: this.config.imapConfig.secure,
      tlsOptions: { rejectUnauthorized: false },
    });

    return new Promise((resolve, reject) => {
      imap.once('ready', () => {
        this.imapConnection = imap;
        resolve(imap);
      });

      imap.once('error', (err) => {
        reject(err);
      });

      imap.connect();
    });
  }

  private async getSmtpTransporter(): Promise<nodemailer.Transporter> {
    if (!this.config.imapConfig) {
      throw new Error('IMAP configuration is required');
    }

    if (this.smtpTransporter) {
      return this.smtpTransporter;
    }

    this.smtpTransporter = nodemailer.createTransport({
      host: this.config.imapConfig.smtpHost,
      port: this.config.imapConfig.smtpPort,
      secure: this.config.imapConfig.smtpSecure,
      auth: {
        user: this.config.imapConfig.user,
        pass: this.config.imapConfig.password,
      },
    });

    return this.smtpTransporter;
  }

  private async openMailbox(mailbox: string): Promise<Imap.Box> {
    const imap = await this.getImapConnection();
    return new Promise((resolve, reject) => {
      imap.openBox(mailbox, false, (err, box) => {
        if (err) reject(err);
        else resolve(box);
      });
    });
  }

  private mapFolderToLabel(folder: string): string {
    const folderMap: Record<string, string> = {
      INBOX: 'INBOX',
      Sent: 'SENT',
      Drafts: 'DRAFT',
      Trash: 'TRASH',
      Spam: 'SPAM',
      Junk: 'SPAM',
    };
    return folderMap[folder] || folder;
  }

  private async parseImapMessage(message: ParsedMail, uid: number): Promise<ParsedMessage> {
    const messageId = message.messageId || `imap-${uid}`;
    const subject = message.subject || '(no subject)';
    const from = message.from?.value?.[0];
    const to = message.to?.value || [];
    const cc = message.cc?.value || [];
    const bcc = message.bcc?.value || [];
    const date = message.date || new Date();

    const htmlBody = message.html ? String(message.html) : '';
    const textBody = message.text ? String(message.text) : '';

    const parsedMessage: ParsedMessage = {
      id: messageId,
      threadId: message.inReplyTo || messageId,
      historyId: null,
      internalDate: date.getTime().toString(),
      date: date.toISOString(),
      from: from
        ? {
            name: from.name || '',
            email: from.address || '',
          }
        : { name: '', email: '' },
      to: to.map((addr) => ({
        name: addr.name || '',
        email: addr.address || '',
      })),
      cc: cc.map((addr) => ({
        name: addr.name || '',
        email: addr.address || '',
      })),
      bcc: bcc.map((addr) => ({
        name: addr.name || '',
        email: addr.address || '',
      })),
      subject,
      textBody,
      htmlBody,
      snippet: textBody.substring(0, 150),
      labelIds: [],
      attachments: (message.attachments || []).map((att) => ({
        filename: att.filename || 'attachment',
        mimeType: att.contentType || 'application/octet-stream',
        size: att.size || 0,
        attachmentId: att.contentId || att.checksum || '',
      })),
      headers: Object.entries(message.headers).map(([name, value]) => ({
        name,
        value: Array.isArray(value) ? value.join(', ') : String(value),
      })),
      $raw: message,
    };

    return parsedMessage;
  }

  private async withErrorHandler<T>(
    operation: string,
    fn: () => Promise<T>,
    context: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      const standardizedError = error as StandardizedError;

      if (FatalErrors.has(standardizedError.code as string)) {
        await deleteActiveConnection(this.config.auth.userId);
        throw new Error(`Fatal error in ${operation}: ${standardizedError.message}`);
      }

      console.error(`Error in ${operation}:`, sanitizeContext({ error, ...context }));
      throw error;
    }
  }

  public getScope(): string {
    return 'imap';
  }

  public async listHistory<T>(historyId: string): Promise<{ history: T[]; historyId: string }> {
    // IMAP doesn't have built-in history API like Gmail
    // Return empty history for now
    return { history: [] as T[], historyId };
  }

  public async getAttachment(messageId: string, attachmentId: string): Promise<string | undefined> {
    return this.withErrorHandler(
      'getAttachment',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('INBOX');

        return new Promise<string | undefined>((resolve, reject) => {
          const fetch = imap.fetch([messageId], {
            bodies: '',
            struct: true,
          });

          fetch.on('message', (msg) => {
            msg.on('body', async (stream) => {
              try {
                const parsed = await simpleParser(stream);
                const attachment = parsed.attachments.find(
                  (att) => att.contentId === attachmentId || att.checksum === attachmentId,
                );

                if (attachment && attachment.content) {
                  resolve(attachment.content.toString('base64'));
                } else {
                  resolve(undefined);
                }
              } catch (err) {
                reject(err);
              }
            });
          });

          fetch.once('error', reject);
          fetch.once('end', () => resolve(undefined));
        });
      },
      { messageId, attachmentId },
    );
  }

  public async getMessageAttachments(messageId: string) {
    return this.withErrorHandler(
      'getMessageAttachments',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('INBOX');

        return new Promise<
          {
            filename: string;
            mimeType: string;
            size: number;
            attachmentId: string;
            headers: { name: string; value: string }[];
            body: string;
          }[]
        >((resolve, reject) => {
          const fetch = imap.fetch([messageId], {
            bodies: '',
            struct: true,
          });

          const attachments: {
            filename: string;
            mimeType: string;
            size: number;
            attachmentId: string;
            headers: { name: string; value: string }[];
            body: string;
          }[] = [];

          fetch.on('message', (msg) => {
            msg.on('body', async (stream) => {
              try {
                const parsed = await simpleParser(stream);
                for (const att of parsed.attachments) {
                  attachments.push({
                    filename: att.filename || 'attachment',
                    mimeType: att.contentType || 'application/octet-stream',
                    size: att.size || 0,
                    attachmentId: att.contentId || att.checksum || '',
                    headers: Object.entries(att.headers || {}).map(([name, value]) => ({
                      name,
                      value: String(value),
                    })),
                    body: att.content ? att.content.toString('base64') : '',
                  });
                }
              } catch (err) {
                reject(err);
              }
            });
          });

          fetch.once('error', reject);
          fetch.once('end', () => resolve(attachments));
        });
      },
      { messageId },
    );
  }

  public async getEmailAliases() {
    return this.withErrorHandler('getEmailAliases', async () => {
      // IMAP doesn't have alias support out of the box
      // Return the primary email from config
      const primaryEmail = this.config.auth.email;
      return [{ email: primaryEmail, primary: true }];
    });
  }

  public async markAsRead(threadIds: string[]) {
    return this.withErrorHandler(
      'markAsRead',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('INBOX');

        return new Promise<void>((resolve, reject) => {
          imap.addFlags(threadIds, ['\\Seen'], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      { threadIds },
    );
  }

  public async markAsUnread(threadIds: string[]) {
    return this.withErrorHandler(
      'markAsUnread',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('INBOX');

        return new Promise<void>((resolve, reject) => {
          imap.delFlags(threadIds, ['\\Seen'], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      { threadIds },
    );
  }

  public async getUserInfo() {
    return this.withErrorHandler('getUserInfo', async () => {
      return {
        address: this.config.auth.email,
        name: this.config.auth.email.split('@')[0],
        photo: '',
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getTokens(_code: string): Promise<{ tokens: { access_token?: string; refresh_token?: string; expiry_date?: number } }> {
    // IMAP doesn't use OAuth tokens
    return { tokens: {} };
  }

  public async count() {
    return this.withErrorHandler('count', async () => {
      const results: { label: string; count: number }[] = [];

      // Get inbox count
      const inbox = await this.openMailbox('INBOX');
      results.push({
        label: 'inbox',
        count: inbox.messages.total,
      });

      return results;
    });
  }

  public normalizeIds(ids: string[]): { threadIds: string[] } {
    return { threadIds: ids };
  }

  public async modifyLabels(
    ids: string[],
    options: { addLabels: string[]; removeLabels: string[] },
  ): Promise<void> {
    return this.withErrorHandler(
      'modifyLabels',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('INBOX');

        // Map labels to IMAP flags
        const flagMap: Record<string, string> = {
          STARRED: '\\Flagged',
          UNREAD: '\\Seen', // Note: UNREAD is inverse of Seen
          IMPORTANT: '\\Flagged',
        };

        for (const label of options.addLabels) {
          const flag = flagMap[label];
          if (flag) {
            await new Promise<void>((resolve, reject) => {
              if (label === 'UNREAD') {
                // Remove Seen flag for UNREAD
                imap.delFlags(ids, [flag], (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              } else {
                imap.addFlags(ids, [flag], (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              }
            });
          }
        }

        for (const label of options.removeLabels) {
          const flag = flagMap[label];
          if (flag) {
            await new Promise<void>((resolve, reject) => {
              if (label === 'UNREAD') {
                // Add Seen flag to remove UNREAD
                imap.addFlags(ids, [flag], (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              } else {
                imap.delFlags(ids, [flag], (err) => {
                  if (err) reject(err);
                  else resolve();
                });
              }
            });
          }
        }
      },
      { ids, options },
    );
  }

  public async getUserLabels(): Promise<Label[]> {
    return this.withErrorHandler('getUserLabels', async () => {
      const imap = await this.getImapConnection();

      return new Promise<Label[]>((resolve, reject) => {
        imap.getBoxes((err, boxes) => {
          if (err) {
            reject(err);
            return;
          }

          const labels: Label[] = [];
          const processBoxes = (boxList: Imap.MailBoxes, prefix = '') => {
            for (const [name, box] of Object.entries(boxList)) {
              const fullName = prefix ? `${prefix}/${name}` : name;
              labels.push({
                id: fullName,
                name: fullName,
                type: 'user',
                color: undefined,
              });

              if (box.children) {
                processBoxes(box.children, fullName);
              }
            }
          };

          processBoxes(boxes);
          resolve(labels);
        });
      });
    });
  }

  public async getLabel(id: string): Promise<Label> {
    return this.withErrorHandler(
      'getLabel',
      async () => {
        return {
          id,
          name: id,
          type: 'user',
          color: undefined,
        };
      },
      { id },
    );
  }

  public async createLabel(label: {
    name: string;
    color?: { backgroundColor: string; textColor: string };
  }): Promise<void> {
    return this.withErrorHandler(
      'createLabel',
      async () => {
        const imap = await this.getImapConnection();

        return new Promise<void>((resolve, reject) => {
          imap.addBox(label.name, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      { label },
    );
  }

  public async updateLabel(
    id: string,
    label: { name: string; color?: { backgroundColor: string; textColor: string } },
  ): Promise<void> {
    return this.withErrorHandler(
      'updateLabel',
      async () => {
        // IMAP doesn't support renaming mailboxes directly
        // We would need to create a new mailbox and move messages
        throw new Error('Updating labels is not supported for IMAP');
      },
      { id, label },
    );
  }

  public async deleteLabel(id: string): Promise<void> {
    return this.withErrorHandler(
      'deleteLabel',
      async () => {
        const imap = await this.getImapConnection();

        return new Promise<void>((resolve, reject) => {
          imap.delBox(id, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      },
      { id },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async revokeToken(_token: string): Promise<boolean> {
    // IMAP doesn't use OAuth tokens
    return true;
  }

  public async deleteAllSpam(): Promise<DeleteAllSpamResponse> {
    return this.withErrorHandler('deleteAllSpam', async () => {
      // Not implemented for IMAP
      return { success: true };
    });
  }

  public async getRawEmail(id: string): Promise<string> {
    return this.withErrorHandler(
      'getRawEmail',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('INBOX');

        return new Promise<string>((resolve, reject) => {
          const fetch = imap.fetch([id], {
            bodies: '',
          });

          let rawEmail = '';

          fetch.on('message', (msg) => {
            msg.on('body', (stream) => {
              let buffer = '';
              stream.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
              });
              stream.once('end', () => {
                rawEmail = buffer;
              });
            });
          });

          fetch.once('error', reject);
          fetch.once('end', () => resolve(rawEmail));
        });
      },
      { id },
    );
  }

  public async list(params: {
    folder: string;
    query?: string;
    maxResults?: number;
    labelIds?: string[];
    pageToken?: string | number;
  }): Promise<{
    threads: { id: string; historyId: string | null; $raw?: unknown }[];
    nextPageToken: string | null;
  }> {
    return this.withErrorHandler(
      'list',
      async () => {
        const imap = await this.getImapConnection();
        const mailbox = params.folder || 'INBOX';
        await this.openMailbox(mailbox);

        const maxResults = params.maxResults || 50;
        const pageToken = typeof params.pageToken === 'number' ? params.pageToken : 0;

        return new Promise((resolve, reject) => {
          imap.search(['ALL'], (err, uids) => {
            if (err) {
              reject(err);
              return;
            }

            // Sort UIDs in descending order (newest first)
            const sortedUids = uids.sort((a, b) => b - a);
            const startIdx = pageToken;
            const endIdx = Math.min(startIdx + maxResults, sortedUids.length);
            const pageUids = sortedUids.slice(startIdx, endIdx);

            const threads = pageUids.map((uid) => ({
              id: String(uid),
              historyId: null,
            }));

            const nextPageToken = endIdx < sortedUids.length ? endIdx : null;

            resolve({
              threads,
              nextPageToken: nextPageToken !== null ? String(nextPageToken) : null,
            });
          });
        });
      },
      params,
    );
  }

  public async get(id: string): Promise<IGetThreadResponse> {
    return this.withErrorHandler(
      'get',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('INBOX');

        return new Promise<IGetThreadResponse>((resolve, reject) => {
          const fetch = imap.fetch([id], {
            bodies: '',
            struct: true,
          });

          let message: ParsedMessage | null = null;

          fetch.on('message', (msg) => {
            msg.on('body', async (stream) => {
              try {
                const parsed = await simpleParser(stream);
                message = await this.parseImapMessage(parsed, parseInt(id));
              } catch (err) {
                reject(err);
              }
            });

            msg.once('attributes', (attrs) => {
              if (message) {
                const flags = attrs.flags || [];
                const labelIds: string[] = [];
                if (!flags.includes('\\Seen')) labelIds.push('UNREAD');
                if (flags.includes('\\Flagged')) labelIds.push('STARRED');
                message.labelIds = labelIds;
              }
            });
          });

          fetch.once('error', reject);
          fetch.once('end', () => {
            if (message) {
              resolve({
                messages: [message],
                latest: message,
                hasUnread: message.labelIds?.includes('UNREAD') || false,
                totalReplies: 1,
                labels: message.labelIds?.map((id) => ({ id, name: id })) || [],
              });
            } else {
              reject(new Error('Message not found'));
            }
          });
        });
      },
      { id },
    );
  }

  public async create(data: IOutgoingMessage): Promise<{ id?: string | null }> {
    return this.withErrorHandler(
      'create',
      async () => {
        const transporter = await this.getSmtpTransporter();

        const message = createMimeMessage();
        message.setSender({
          name: data.from?.name || '',
          addr: data.from?.email || this.config.auth.email,
        });
        message.setSubject(data.subject || '');

        if (data.to) {
          const toAddresses = data.to.split(',').map((addr) => addr.trim());
          message.setRecipients(toAddresses);
        }

        if (data.cc) {
          const ccAddresses = data.cc.split(',').map((addr) => addr.trim());
          message.setCc(ccAddresses);
        }

        if (data.bcc) {
          const bccAddresses = data.bcc.split(',').map((addr) => addr.trim());
          message.setBcc(bccAddresses);
        }

        if (data.inReplyTo) {
          message.setHeader('In-Reply-To', data.inReplyTo);
        }

        if (data.references) {
          message.setHeader('References', data.references);
        }

        const htmlContent = sanitizeTipTapHtml(data.message || '');
        message.addMessage({
          contentType: 'text/html',
          data: htmlContent,
        });

        // Add attachments
        if (data.attachments) {
          for (const attachment of data.attachments) {
            message.addAttachment({
              filename: attachment.name,
              contentType: attachment.type,
              data: attachment.base64,
            });
          }
        }

        const mimeContent = message.asRaw();

        await transporter.sendMail({
          from: data.from?.email || this.config.auth.email,
          to: data.to,
          cc: data.cc,
          bcc: data.bcc,
          subject: data.subject,
          raw: mimeContent,
        });

        return { id: null };
      },
      { data },
    );
  }

  public async sendDraft(id: string, data: IOutgoingMessage): Promise<void> {
    await this.create(data);
    await this.deleteDraft(id);
  }

  public async createDraft(
    data: CreateDraftData,
  ): Promise<{ id?: string | null; success?: boolean; error?: string }> {
    return this.withErrorHandler(
      'createDraft',
      async () => {
        // Store draft in Drafts folder
        const imap = await this.getImapConnection();
        await this.openMailbox('Drafts');

        const message = createMimeMessage();
        message.setSender({
          name: '',
          addr: data.fromEmail || this.config.auth.email,
        });
        message.setSubject(data.subject || '');

        if (data.to) {
          const toAddresses = data.to.split(',').map((addr) => addr.trim());
          message.setRecipients(toAddresses);
        }

        if (data.cc) {
          const ccAddresses = data.cc.split(',').map((addr) => addr.trim());
          message.setCc(ccAddresses);
        }

        if (data.bcc) {
          const bccAddresses = data.bcc.split(',').map((addr) => addr.trim());
          message.setBcc(bccAddresses);
        }

        const htmlContent = sanitizeTipTapHtml(data.message || '');
        message.addMessage({
          contentType: 'text/html',
          data: htmlContent,
        });

        const mimeContent = message.asRaw();

        return new Promise((resolve, reject) => {
          imap.append(mimeContent, { mailbox: 'Drafts' }, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve({ id: null, success: true });
            }
          });
        });
      },
      { data },
    );
  }

  public async getDraft(id: string): Promise<ParsedDraft> {
    return this.withErrorHandler(
      'getDraft',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('Drafts');

        return new Promise<ParsedDraft>((resolve, reject) => {
          const fetch = imap.fetch([id], {
            bodies: '',
          });

          fetch.on('message', (msg) => {
            msg.on('body', async (stream) => {
              try {
                const parsed = await simpleParser(stream);
                resolve({
                  id,
                  to: parsed.to?.value?.map((addr) => addr.address || '') || [],
                  subject: parsed.subject || '',
                  content: parsed.html ? String(parsed.html) : String(parsed.text || ''),
                  cc: parsed.cc?.value?.map((addr) => addr.address || '') || [],
                  bcc: parsed.bcc?.value?.map((addr) => addr.address || '') || [],
                  rawMessage: {
                    internalDate: parsed.date?.toISOString() || null,
                  },
                });
              } catch (err) {
                reject(err);
              }
            });
          });

          fetch.once('error', reject);
        });
      },
      { id },
    );
  }

  public async listDrafts(params: {
    q?: string;
    maxResults?: number;
    pageToken?: string;
  }): Promise<{
    threads: { id: string; historyId: string | null; $raw: unknown }[];
    nextPageToken: string | null;
  }> {
    return this.withErrorHandler(
      'listDrafts',
      async () => {
        return this.list({
          folder: 'Drafts',
          query: params.q,
          maxResults: params.maxResults,
          pageToken: params.pageToken,
        });
      },
      params,
    );
  }

  public async delete(id: string): Promise<void> {
    return this.withErrorHandler(
      'delete',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('INBOX');

        return new Promise<void>((resolve, reject) => {
          imap.addFlags([id], ['\\Deleted'], (err) => {
            if (err) {
              reject(err);
            } else {
              imap.expunge((expungeErr) => {
                if (expungeErr) reject(expungeErr);
                else resolve();
              });
            }
          });
        });
      },
      { id },
    );
  }

  public async deleteDraft(id: string): Promise<void> {
    return this.withErrorHandler(
      'deleteDraft',
      async () => {
        const imap = await this.getImapConnection();
        await this.openMailbox('Drafts');

        return new Promise<void>((resolve, reject) => {
          imap.addFlags([id], ['\\Deleted'], (err) => {
            if (err) {
              reject(err);
            } else {
              imap.expunge((expungeErr) => {
                if (expungeErr) reject(expungeErr);
                else resolve();
              });
            }
          });
        });
      },
      { id },
    );
  }
}
