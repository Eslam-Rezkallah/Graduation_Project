import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService, BASE } from './auth.service';

export type ConvType = 'channel' | 'group' | 'direct' | 'organization' | 'team';
export type MsgType  = 'text' | 'image' | 'voice' | 'file';

export interface BackendMessage {
  _id:         string;
  chatRoomId:  string;
  senderId:    { _id: string; username: string; image?: any };
  content:     string;
  messageType: MsgType;
  attachments?: {
    type?: 'image' | 'voice' | 'file' | 'video';
    url: string;
    public_id?: string;
    originalName: string;
    mimeType?: string;
    size?: number;
    duration?: number;
  }[];
  replyTo?:    string | BackendMessage;
  createdAt:   string;
  edited?:     boolean;
  reactions?:  { emoji: string; userId: string; username?: string }[];
  readBy?:     string[];
  deliveredTo?: string[];
}

export interface Conversation {
  _id:           string;
  name:          string | null;
  type:          ConvType;
  members:       { _id: string; username: string; image?: any }[];
  admins?:       { _id: string; username: string }[];
  lastMessage?:  any;
  lastMessageAt?: string;
  unreadCounts?: Record<string, number>;
  unreadCount?:  number;
  isDeleted?:    boolean;
  isPrivate?:    boolean;
  organizationId?: string;
}

export interface ChatSummarizeOptions {
  window?: 'day' | 'week';
  limit?: number;
  maxSummaryLength?: number;
  minSummaryLength?: number;
  includeVoiceAnalysis?: boolean;
  includeImageOcr?: boolean;
}

export interface ChatVoiceEmotion {
  label: string;
  confidence: string | number;
  verdict?: string;
}

export interface ChatVoiceAnalysis {
  user?: string;
  transcript?: string;
  translated_transcript?: string;
  emotion?: ChatVoiceEmotion;
}

export interface ChatImageOcr {
  user?: string;
  text?: string;
  app?: string;
  category?: string;
}

export interface ChatSummarizeChannel {
  channel: string;
  messageCount: number;
  summary: string;
  voiceAnalyses: ChatVoiceAnalysis[];
  imageOcr: ChatImageOcr[];
}

export interface ChatSummarizeResult {
  roomId: string;
  messageCount: number;
  sinceUtc: string | null;
  nowUtc: string | null;
  overallSummary: string;
  channels: ChatSummarizeChannel[];
  voiceAnalyses: ChatVoiceAnalysis[];
  imageOcr: ChatImageOcr[];
}

/** Wrapper returned by POST /chat/rooms/:roomId/messages/ai/summarize */
export interface ChatSummarizeApiResponse {
  success: boolean;
  message: string;
  data: ChatSummarizeResult;
}

@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);

  private get orgId(): string {
    return this.auth.currentUser()?.orgId ?? '';
  }

  // ── Rooms ─────────────────────────────────────────────────

  async loadRooms(): Promise<Conversation[]> {
    try {
      // ✅ استخدم /org/:orgId/chat-rooms لو في orgId
      // ده بيرجع الـ rooms مجمعة حسب النوع + unread
      if (this.orgId) {
        const res = await firstValueFrom(
          this.http.get<{ data: any }>(`${BASE}/org/${this.orgId}/chat-rooms`)
        );
        // Response: { data: { rooms: [...], grouped: {...}, total } }
        const rooms: Conversation[] = res?.data?.rooms ?? [];
        return rooms.filter(r => !r.isDeleted);
      }

      // Fallback: /chat/rooms
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(`${BASE}/chat/rooms?limit=50`)
      );
      const rooms: Conversation[] = res?.data?.rooms ?? res?.data ?? [];
      return rooms.filter(r => !r.isDeleted);

    } catch (err) {
      console.error('[ChatService] loadRooms:', err);
      return [];
    }
  }

  async getRoom(roomId: string): Promise<Conversation | null> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(`${BASE}/chat/rooms/${roomId}`)
      );
      return res?.data?.room ?? null;
    } catch {
      return null;
    }
  }

  async getUnreadCounts(): Promise<Record<string, number>> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(`${BASE}/chat/rooms/unread-counts`)
      );
      // Response: { data: { counts: { roomId: number }, totalUnread } }
      return res?.data?.counts ?? {};
    } catch {
      return {};
    }
  }

  // ✅ FIX: الباك بياخد { targetUserId }
  async createDM(targetUserId: string): Promise<Conversation | null> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ data: any }>(`${BASE}/chat/rooms/direct`, {
          targetUserId, // ✅ الاسم الصح
        })
      );
      return res?.data?.room ?? null;
    } catch (err: any) {
      console.error('[ChatService] createDM:', err?.error?.message);
      return null;
    }
  }

  async createChannel(name: string, isPrivate = false): Promise<Conversation | null> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ data: any }>(`${BASE}/chat/rooms/channel`, {
          name,
          organizationId: this.orgId,
          isPrivate,
        })
      );
      return res?.data?.room ?? null;
    } catch (err: any) {
      console.error('[ChatService] createChannel:', err?.error?.message);
      return null;
    }
  }

  async createGroup(name: string, memberIds: string[]): Promise<Conversation | null> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ data: any }>(`${BASE}/chat/rooms/group`, {
          name,
          organizationId: this.orgId,
          memberIds,
        })
      );
      return res?.data?.room ?? null;
    } catch (err: any) {
      console.error('[ChatService] createGroup:', err?.error?.message);
      return null;
    }
  }

  async leaveRoom(roomId: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.delete(`${BASE}/chat/rooms/${roomId}/leave`)
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Messages ───────────────────────────────────────────────

  async loadMessages(
    roomId: string,
    limit = 50,
    before?: string
  ): Promise<BackendMessage[]> {
    try {
      const params: any = { limit: String(limit) };
      if (before) params.before = before;

      const res = await firstValueFrom(
        this.http.get<{ data: any }>(
          `${BASE}/chat/rooms/${roomId}/messages`,
          { params }
        )
      );
      // Response: { data: { messages: [...], total, hasMore } }
      return res?.data?.messages ?? [];
    } catch (err) {
      console.error('[ChatService] loadMessages:', err);
      return [];
    }
  }

  async searchMessages(roomId: string, query: string): Promise<BackendMessage[]> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(
          `${BASE}/chat/rooms/${roomId}/messages/search`,
          { params: { q: query, page: '1', limit: '20' } }
        )
      );
      return res?.data?.messages ?? [];
    } catch {
      return [];
    }
  }

  /**
   * AI summary for a room's recent messages.
   * POST /chat/rooms/:roomId/messages/ai/summarize
   *
   * Request body (all optional):
   *   window, limit, maxSummaryLength, minSummaryLength,
   *   includeVoiceAnalysis, includeImageOcr
   */
  async summarizeRoom(
    roomId: string,
    options: ChatSummarizeOptions = {},
  ): Promise<ChatSummarizeResult> {
    const res = await firstValueFrom(
      this.http.post<ChatSummarizeApiResponse>(
        `${BASE}/chat/rooms/${roomId}/messages/ai/summarize`,
        options,
      ),
    );
    return res.data;
  }

  async sendMessage(
    roomId:      string,
    content:     string,
    messageType: MsgType = 'text',
    replyTo?:    string,
  ): Promise<BackendMessage | null> {
    try {
      const body: any = { content, messageType };
      if (replyTo) body.replyTo = replyTo;

      const res = await firstValueFrom(
        this.http.post<{ data: any }>(
          `${BASE}/chat/rooms/${roomId}/messages`,
          body
        )
      );
      // Response: { data: { message: {...} } }
      return res?.data?.message ?? null;
    } catch (err: any) {
      console.error('[ChatService] sendMessage:', err?.error?.message);
      return null;
    }
  }

  /**
   * Send a message with file attachments (multipart/form-data).
   * The backend route uses multer `.array("attachments", 5)` and derives the
   * per-attachment type from the mime type. We set the message-level
   * `messageType` so the UI knows which renderer to use.
   */
  async sendMessageWithAttachments(
    roomId:      string,
    content:     string,
    files:       File[],
    messageType: MsgType = 'file',
    replyTo?:    string,
  ): Promise<BackendMessage | null> {
    try {
      const fd = new FormData();
      fd.append('content', content ?? '');
      fd.append('messageType', messageType);
      if (replyTo) fd.append('replyTo', replyTo);
      for (const f of files) fd.append('attachments', f, f.name);

      const res = await firstValueFrom(
        this.http.post<{ data: any }>(
          `${BASE}/chat/rooms/${roomId}/messages`,
          fd
        )
      );
      return res?.data?.message ?? null;
    } catch (err: any) {
      console.error('[ChatService] sendMessageWithAttachments:', err?.error?.message || err?.message);
      throw err;
    }
  }

  async editMessage(
    roomId:    string,
    messageId: string,
    content:   string
  ): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.patch(
          `${BASE}/chat/rooms/${roomId}/messages/${messageId}`,
          { content }
        )
      );
      return true;
    } catch {
      return false;
    }
  }

  async deleteMessage(
    roomId:    string,
    messageId: string,
    deleteType: 'me' | 'everyone' = 'everyone'
  ): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.delete(
          `${BASE}/chat/rooms/${roomId}/messages/${messageId}`,
          { body: { deleteType } }
        )
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Reactions ──────────────────────────────────────────────

  // ✅ FIX: الباك بياخد { reaction } مش { emoji }
  async addReaction(
    roomId:    string,
    messageId: string,
    reaction:  string
  ): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.post(
          `${BASE}/chat/rooms/${roomId}/messages/${messageId}/reactions`,
          { reaction } // ✅ الاسم الصح
        )
      );
      return true;
    } catch {
      return false;
    }
  }

  async removeReaction(roomId: string, messageId: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.delete(
          `${BASE}/chat/rooms/${roomId}/messages/${messageId}/reactions`
        )
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Read Receipts ──────────────────────────────────────────

  async markSeen(roomId: string, messageId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.patch(
          `${BASE}/chat/rooms/${roomId}/messages/${messageId}/seen`,
          {}
        )
      );
    } catch { /* silent */ }
  }

  async markDelivered(roomId: string, messageId: string): Promise<void> {
    try {
      await firstValueFrom(
        this.http.patch(
          `${BASE}/chat/rooms/${roomId}/messages/${messageId}/delivered`,
          {}
        )
      );
    } catch { /* silent */ }
  }

  // ── Org Members (for DM/Group pickers) ────────────────────

  async loadOrgMembers(): Promise<
    { _id: string; username: string; email: string; image?: any }[]
  > {
    if (!this.orgId) return [];
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(
          `${BASE}/org/${this.orgId}/members?page=1&limit=100`
        )
      );
      // Response: { data: { members: [{ userId: { _id, username, email }, role }] } }
      const members = res?.data?.members ?? [];
      return members
        .filter((m: any) => m.userId)
        .map((m: any) => ({
          _id:      m.userId._id ?? m.userId,
          username: m.userId.username ?? m.userId.email?.split('@')[0] ?? 'Unknown',
          email:    m.userId.email ?? '',
          image:    m.userId.image ?? null,
        }));
    } catch {
      return [];
    }
  }

  // ── Saved / Bookmarked Messages ───────────────────────────

  async saveMessage(roomId: string, messageId: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.post(`${BASE}/chat/rooms/${roomId}/messages/${messageId}/save`, {})
      );
      return true;
    } catch {
      return false;
    }
  }

  async unsaveMessage(roomId: string, messageId: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.delete(`${BASE}/chat/rooms/${roomId}/messages/${messageId}/save`)
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Bookmarked messages for the current user (optionally scoped to a room). */
  async getSavedMessages(roomId?: string): Promise<any[]> {
    try {
      const params: any = { page: '1', limit: '50' };
      if (roomId) params.roomId = roomId;
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(`${BASE}/me/saved-messages`, { params })
      );
      return res?.data?.items ?? [];
    } catch {
      return [];
    }
  }

  /** Mentions inbox — every message that @-mentions the current user. */
  async getMyMentions(): Promise<any[]> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(`${BASE}/me/mentions`, {
          params: { page: '1', limit: '50' },
        })
      );
      return res?.data?.items ?? [];
    } catch {
      return [];
    }
  }

  // ── Schedule Messages ─────────────────────────────────────

  async scheduleMessage(
    roomId: string,
    content: string,
    sendAt: string
  ): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.post(
          `${BASE}/chat/rooms/${roomId}/messages/schedule`,
          { content, sendAt }
        )
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Pinned Messages ────────────────────────────────────────

  async getPinnedMessages(roomId: string): Promise<any[]> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(`${BASE}/chat/rooms/${roomId}/messages/pinned`)
      );
      // Backend returns { data: { count, items } }.
      return res?.data?.items ?? res?.data?.messages ?? [];
    } catch {
      return [];
    }
  }

  async pinMessage(roomId: string, messageId: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.post(`${BASE}/chat/rooms/${roomId}/messages/${messageId}/pin`, {})
      );
      return true;
    } catch {
      return false;
    }
  }

  async unpinMessage(roomId: string, messageId: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.delete(`${BASE}/chat/rooms/${roomId}/messages/${messageId}/pin`)
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Tabs ───────────────────────────────────────────────────

  async getTabs(roomId: string): Promise<any[]> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(`${BASE}/chat/rooms/${roomId}/tabs`)
      );
      // Backend may return { data: { tabs: [...] } } or { data: [...] }.
      // Always coerce to an array so the @for over roomTabs() can't crash.
      const data = res?.data;
      const tabs = data?.tabs ?? data;
      return Array.isArray(tabs) ? tabs : [];
    } catch {
      return [];
    }
  }

  async createTab(roomId: string, name: string, type?: string): Promise<any> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ data: any }>(`${BASE}/chat/rooms/${roomId}/tabs`, { name, type })
      );
      return res?.data?.tab ?? res?.data ?? null;
    } catch {
      return null;
    }
  }

  async updateTab(roomId: string, tabId: string, data: any): Promise<any> {
    try {
      const res = await firstValueFrom(
        this.http.patch<{ data: any }>(`${BASE}/chat/rooms/${roomId}/tabs/${tabId}`, data)
      );
      return res?.data?.tab ?? res?.data ?? null;
    } catch {
      return null;
    }
  }

  async deleteTab(roomId: string, tabId: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.delete(`${BASE}/chat/rooms/${roomId}/tabs/${tabId}`)
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Forward & Threads ──────────────────────────────────────

  async forwardMessage(
    targetRoomId: string,
    messageId: string
  ): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.post(
          `${BASE}/chat/rooms/${targetRoomId}/messages/forward`,
          { sourceMessageId: messageId }
        )
      );
      return true;
    } catch {
      return false;
    }
  }

  async getThread(roomId: string, messageId: string): Promise<any[]> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(
          `${BASE}/chat/rooms/${roomId}/messages/${messageId}/thread`
        )
      );
      // Backend returns { data: { parent, replyCount, replies } }.
      return res?.data?.replies ?? res?.data?.messages ?? [];
    } catch {
      return [];
    }
  }

  // ── Scheduled Messages ─────────────────────────────────────

  async getScheduledMessages(roomId: string): Promise<any[]> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(
          `${BASE}/chat/rooms/${roomId}/messages/scheduled`
        )
      );
      return res?.data?.messages ?? res?.data ?? [];
    } catch {
      return [];
    }
  }

  async deleteScheduledMessage(roomId: string, msgId: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.delete(
          `${BASE}/chat/rooms/${roomId}/messages/scheduled/${msgId}`
        )
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Channel Discovery & Membership ────────────────────────

  async browseChannels(orgId: string, search?: string): Promise<any[]> {
    try {
      const params: any = { organizationId: orgId };
      if (search) params.search = search;
      const res = await firstValueFrom(
        this.http.get<{ data: any }>(
          `${BASE}/chat/rooms/browse`,
          { params }
        )
      );
      return res?.data?.rooms ?? res?.data?.channels ?? res?.data ?? [];
    } catch {
      return [];
    }
  }

  async joinChannel(roomId: string): Promise<Conversation | null> {
    try {
      const res = await firstValueFrom(
        this.http.post<{ data: any }>(`${BASE}/chat/rooms/${roomId}/join`, {})
      );
      return res?.data?.room ?? null;
    } catch {
      return null;
    }
  }

  async addMemberToRoom(roomId: string, userId: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.post(`${BASE}/chat/rooms/${roomId}/members/${userId}`, {})
      );
      return true;
    } catch {
      return false;
    }
  }
}