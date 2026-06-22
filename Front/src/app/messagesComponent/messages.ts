import {
  Component, signal, inject, OnInit, OnDestroy,
  ElementRef, ViewChild, AfterViewChecked,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService, SOCKET_BASE } from '../services/auth.service';
import {
  ChatService, Conversation, BackendMessage, MsgType,
  ChatSummarizeResult,
} from '../services/chat.service';
import { CallService }   from '../services/call.service';
import { SocketService } from '../services/socket.service';
import { ToastService }  from '../services/toast.service';

const EMOJI_QUICK = ['👍', '❤️', '😂', '🎉', '😮', '😢'];

@Component({
  selector: 'app-messages',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, DatePipe],
  templateUrl: './messages.html',
  styleUrls: ['messages.css'],
})
export class MessagesComponent implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('chatScroll') chatScroll!: ElementRef;
  @ViewChild('composerInput') composerInput?: ElementRef<HTMLInputElement>;

  private chatService  = inject(ChatService);
  private auth         = inject(AuthService);
  private route        = inject(ActivatedRoute);
  callService          = inject(CallService);
  socketService        = inject(SocketService);
  private toast        = inject(ToastService);

  // Deep-link intent (e.g. coming from a meeting "Join Call" button):
  //   /messages?room=<roomId>&call=video|voice
  private pendingRoomId: string | null = null;
  private pendingCallType: 'video' | 'voice' | null = null;

  // ── State ──────────────────────────────────────────────
  rooms           = signal<Conversation[]>([]);
  selectedRoom    = signal<Conversation | null>(null);
  messages        = signal<BackendMessage[]>([]);
  messageText     = signal('');
  pendingFiles    = signal<File[]>([]);
  uploadingFiles  = signal(false);
  searchQuery     = signal('');
  loadingRooms    = signal(true);
  loadingMessages = signal(false);
  showMembers     = signal(false);
  typingUsers     = signal<string[]>([]);

  // Create channel/group
  showCreateChannel     = signal(false);
  showCreateGroup       = signal(false);
  showCreateDM          = signal(false);
  newChannelName        = signal('');
  newGroupName          = signal('');
  selectedGroupMembers  = signal<string[]>([]);

  // Org members (for DM/group pickers)
  orgMembers = signal<{ _id: string; username: string; email: string; image?: any }[]>([]);

  // Edit/delete
  editingMsgId  = signal<string | null>(null);
  editingText   = signal('');

  // Reactions
  reactionMenuMsgId = signal<string | null>(null);
  emojiOptions      = EMOJI_QUICK;

  // Pin & Save
  pinnedMsgIds   = signal<Set<string>>(new Set());
  pinnedMessages = signal<any[]>([]);
  showPinned     = signal(false);

  // Saved (bookmarked) messages
  showSaved    = signal(false);
  savedMessages = signal<any[]>([]);
  savedLoading = signal(false);

  // Mentions inbox
  showMentions    = signal(false);
  mentions        = signal<any[]>([]);
  mentionsLoading = signal(false);

  // @-mention autocomplete (compose box)
  mentionMatches   = signal<{ _id: string; username: string }[]>([]);
  private mentionAnchor = -1; // index of the '@' currently being completed

  // Highlight a message after jumping to it
  highlightedMsgId = signal<string | null>(null);

  // Calls
  callHistory     = signal<any[]>([]);
  activeCallInfo  = signal<any | null>(null);
  showCallHistory = signal(false);

  // Search
  showSearch      = signal(false);
  msgSearchQuery  = signal('');
  searchResults   = signal<BackendMessage[]>([]);
  searching       = signal(false);

  // AI summarize (in-room panel, not a separate page)
  showSummarize         = signal(false);
  summarizing           = signal(false);
  summarizeResult       = signal<ChatSummarizeResult | null>(null);
  summarizeWindow       = signal<'day' | 'week' | ''>('');
  summarizeIncludeVoice = signal(true);
  summarizeIncludeImage = signal(true);

  // Forward
  forwardingMsgId = signal<string | null>(null);
  forwardTargetId  = signal('');
  forwarding       = signal(false);

  // Thread
  threadMsgId  = signal<string | null>(null);
  threadMsgs   = signal<BackendMessage[]>([]);
  threadLoading = signal(false);
  threadReply   = signal('');

  // Scheduled messages
  showScheduled     = signal(false);
  scheduledMessages = signal<any[]>([]);
  showScheduleForm  = signal(false);
  scheduleContent   = signal('');
  scheduleSendAt    = signal('');
  scheduling        = signal(false);

  // Channel Tabs
  roomTabs      = signal<any[]>([]);
  showAddTab    = signal(false);
  newTabName    = signal('');
  newTabType    = signal('wiki');
  addingTab     = signal(false);
  tabTypes      = ['wiki', 'tasks', 'pinned', 'files', 'custom'];
  editingTabId   = signal<string | null>(null);
  editingTabName = signal('');

  // Channel Browse / Join / Leave
  showBrowseChannels  = signal(false);
  browseResults       = signal<any[]>([]);
  browseSearch        = signal('');
  browseLoading       = signal(false);
  joiningChannelId    = signal<string | null>(null);

  // Add member to room
  showAddMember       = signal(false);
  addMemberQuery      = signal('');
  addingMemberId      = signal<string | null>(null);
  savingTabEdit  = signal(false);

  private socket: any = null;
  private shouldScroll = false;
  private typingTimeout: any = null;

  get currentUser()  { return this.auth.currentUser(); }
  get orgId(): string { return this.currentUser?.orgId ?? ''; }

  // ── Filtered rooms ─────────────────────────────────────
  get channels() { return this.rooms().filter(r => r.type === 'channel'); }
  get groups()   { return this.rooms().filter(r => r.type === 'group');   }
  get dms()      { return this.rooms().filter(r => r.type === 'direct');  }

  get filteredRooms(): Conversation[] | null {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return null;
    return this.rooms().filter(r =>
      (r.name ?? '').toLowerCase().includes(q) ||
      r.members.some(m => m.username.toLowerCase().includes(q))
    );
  }

  // Members not in any existing DM with current user (for new DM picker)
  get availableDMMembers() {
    const myId = this.currentUser?._id;
    const existingDMUserIds = new Set(
      this.dms.flatMap(r => r.members.filter(m => m._id !== myId).map(m => m._id))
    );
    return this.orgMembers().filter(m =>
      m._id !== myId && !existingDMUserIds.has(m._id)
    );
  }

  getRoomDisplayName(room: Conversation): string {
    if (room.name) return room.name;
    if (room.type === 'direct') {
      const other = room.members.find(m => m._id !== this.currentUser?._id);
      return other?.username ?? 'Direct Message';
    }
    return 'Chat';
  }

  getRoomInitial(room: Conversation): string {
    return this.getRoomDisplayName(room).charAt(0).toUpperCase();
  }

  getUnread(room: Conversation): number {
    const uid = this.currentUser?._id;
    if (!uid || !room.unreadCounts) return 0;
    return room.unreadCounts[uid] ?? 0;
  }

  isMsgOwn(msg: BackendMessage): boolean {
    return msg.senderId?._id === this.currentUser?._id;
  }

  formatTime(dateStr: string): string {
    return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** Human-readable file size (e.g. "1.2 MB"). */
  formatFileSize(bytes?: number): string {
    if (!bytes || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  /** Format a duration in seconds as m:ss. */
  formatDuration(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /** Pick an emoji icon for a file attachment based on its name/mime type. */
  fileIcon(att: { originalName?: string; mimeType?: string }): string {
    const name = (att?.originalName ?? '').toLowerCase();
    const mime = (att?.mimeType ?? '').toLowerCase();
    if (mime.includes('pdf') || name.endsWith('.pdf')) return '📕';
    if (mime.includes('zip') || /\.(zip|rar|7z|tar|gz)$/.test(name)) return '🗜️';
    if (mime.includes('word') || /\.(docx?|odt)$/.test(name)) return '📘';
    if (/\.(xlsx?|csv|ods)$/.test(name) || mime.includes('sheet')) return '📗';
    if (/\.(pptx?|odp)$/.test(name) || mime.includes('presentation')) return '📙';
    if (mime.startsWith('video/')) return '🎬';
    if (mime.startsWith('audio/')) return '🎵';
    return '📄';
  }

  // ── Lifecycle ──────────────────────────────────────────
  ngOnInit() {
    // Honor a deep-link from elsewhere (e.g. a meeting's "Join Call" button).
    const qp = this.route.snapshot.queryParamMap;
    this.pendingRoomId = qp.get('room');
    const call = qp.get('call');
    this.pendingCallType = call === 'voice' ? 'voice' : call === 'video' ? 'video' : null;

    this.loadRooms();
    this.loadOrgMembers();
    this.connectSocket();
  }

  ngOnDestroy() {
    this.socketService.activeRoomId.set(null);
    this.disconnectSocket();
  }

  ngAfterViewChecked() {
    if (this.shouldScroll && this.chatScroll) {
      const el = this.chatScroll.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.shouldScroll = false;
    }
  }

  // ── Load rooms ─────────────────────────────────────────
  async loadRooms() {
    this.loadingRooms.set(true);
    const rooms = await this.chatService.loadRooms();
    this.rooms.set(rooms);

    // A deep-link (?room=…) takes priority over the default first-room.
    if (this.pendingRoomId) {
      const target = rooms.find(r => r._id === this.pendingRoomId);
      this.pendingRoomId = null;
      if (target) {
        await this.selectRoom(target);
        if (this.pendingCallType) {
          const type = this.pendingCallType;
          this.pendingCallType = null;
          // selectRoom loads the active-call info; give it a tick first.
          setTimeout(() => this.startOrJoinCall(type), 300);
        }
        this.loadingRooms.set(false);
        return;
      }
    }

    if (rooms.length > 0 && !this.selectedRoom()) {
      this.selectRoom(rooms[0]);
    }
    this.loadingRooms.set(false);
  }

  // ── Load org members (for DM/group pickers) ────────────
  async loadOrgMembers() {
    const members = await this.chatService.loadOrgMembers();
    this.orgMembers.set(members);
  }

  // ── Select room ────────────────────────────────────────
  async selectRoom(room: Conversation) {
    this.selectedRoom.set(room);
    this.socketService.activeRoomId.set(room._id);
    this.showMembers.set(false);
    this.editingMsgId.set(null);
    this.reactionMenuMsgId.set(null);
    this.shouldScroll = true;

    await this.loadMessages(room._id);

    // Load pinned messages for this room (both the id-set used by the
    // per-message pin toggle, and the full list shown in the pinned banner)
    this.showPinned.set(false);
    this.chatService.getPinnedMessages(room._id).then(pinned => {
      const list = Array.isArray(pinned) ? pinned : [];
      this.pinnedMessages.set(list);
      this.pinnedMsgIds.set(new Set(list.map(m => m._id)));
    });

    // Load channel tabs (channels only)
    if (room.type === 'channel') {
      this.loadTabs(room._id);
    } else {
      this.roomTabs.set([]);
    }

    // Load active call + history
    this.callService.getActiveCall(room._id).then(c => this.activeCallInfo.set(c));
    this.callHistory.set([]);
    this.showCallHistory.set(false);

    if (this.socket) {
      this.socket.emit('join_room', { roomId: room._id });
    }

    // Mark last message as seen via REST
    const msgs = this.messages();
    if (msgs.length > 0) {
      this.chatService.markSeen(room._id, msgs[msgs.length - 1]._id);
    }
  }

  // ── Load messages ──────────────────────────────────────
  async loadMessages(roomId: string) {
    this.loadingMessages.set(true);
    const msgs = await this.chatService.loadMessages(roomId);
    this.messages.set(msgs);
    this.shouldScroll = true;
    this.loadingMessages.set(false);
  }

  // ── Send message ───────────────────────────────────────
  async sendMessage() {
    const text = this.messageText().trim();
    const room = this.selectedRoom();
    const files = this.pendingFiles();
    if ((!text && files.length === 0) || !room) return;

    // ── With attachments: upload via multipart ──────────────
    if (files.length > 0) {
      const messageType = files.every(f => f.type.startsWith('image/'))
        ? 'image'
        : files.every(f => f.type.startsWith('audio/'))
          ? 'voice'
          : 'file';
      this.uploadingFiles.set(true);
      try {
        await this.chatService.sendMessageWithAttachments(room._id, text, files, messageType);
        this.messageText.set('');
        this.pendingFiles.set([]);
        this.mentionMatches.set([]);
        if (this.composerInput) this.composerInput.nativeElement.value = '';
      } catch (err: any) {
        this.toast.error(err?.error?.message || 'Failed to upload attachment');
      } finally {
        this.uploadingFiles.set(false);
      }
      return;
    }

    this.messageText.set('');
    this.mentionMatches.set([]);
    // One-way [ngModel] can leave the typed text in the DOM after the signal
    // resets; clear the native input directly so the composer is always empty.
    if (this.composerInput) this.composerInput.nativeElement.value = '';

    // Send via REST (persists to DB). Do NOT add the returned message to the
    // array here — the backend broadcasts it via socket and receive_message
    // (with dedup) will display it. Adding here too creates a race where the
    // socket fires before this await returns, inserting the same message twice.
    await this.chatService.sendMessage(room._id, text);
  }

  /** Handle file selection from the composer's attach input. */
  onAttachSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const picked = Array.from(input.files ?? []);
    if (!picked.length) return;
    // Backend caps at 5 attachments / 5 MB each.
    const tooBig = picked.find(f => f.size > 5 * 1024 * 1024);
    if (tooBig) {
      this.toast.error(`"${tooBig.name}" exceeds the 5 MB limit`);
      input.value = '';
      return;
    }
    this.pendingFiles.update(list => [...list, ...picked].slice(0, 5));
    input.value = ''; // allow re-selecting the same file
  }

  removePendingFile(index: number) {
    this.pendingFiles.update(list => list.filter((_, i) => i !== index));
  }

  // ── Voice messages (MediaRecorder) ──────────────────────
  isRecording      = signal(false);
  recordingSeconds = signal(0);
  private mediaRecorder?: MediaRecorder;
  private mediaStream?: MediaStream;
  private recordedChunks: Blob[] = [];
  private recordTimer?: any;
  private cancelRecord = false;

  async startRecording() {
    if (this.isRecording()) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this.toast.error('Voice recording is not supported in this browser');
      return;
    }
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.toast.error('Microphone access was denied');
      return;
    }
    // Pick a mime type the browser supports (the backend now accepts webm/ogg/mp4).
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
    const mimeType = candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
    this.recordedChunks = [];
    this.cancelRecord = false;
    this.mediaRecorder = new MediaRecorder(this.mediaStream, mimeType ? { mimeType } : undefined);
    this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
    this.mediaRecorder.onstop = () => this.finishRecording(mimeType || 'audio/webm');
    this.mediaRecorder.start();

    this.isRecording.set(true);
    this.recordingSeconds.set(0);
    this.recordTimer = setInterval(() => {
      this.recordingSeconds.update(s => s + 1);
      if (this.recordingSeconds() >= 120) this.stopRecording(); // 2-min cap
    }, 1000);
  }

  /** Stop and SEND the recording. */
  stopRecording() {
    if (!this.isRecording()) return;
    this.cancelRecord = false;
    this.teardownRecorder();
  }

  /** Stop and DISCARD the recording. */
  cancelRecording() {
    if (!this.isRecording()) return;
    this.cancelRecord = true;
    this.teardownRecorder();
  }

  private teardownRecorder() {
    if (this.recordTimer) { clearInterval(this.recordTimer); this.recordTimer = undefined; }
    try { this.mediaRecorder?.stop(); } catch { /* already stopped */ }
    this.mediaStream?.getTracks().forEach(t => t.stop());
    this.isRecording.set(false);
  }

  private async finishRecording(mimeType: string) {
    const stream = this.mediaStream;
    this.mediaStream = undefined;
    this.mediaRecorder = undefined;
    if (this.cancelRecord || this.recordedChunks.length === 0) {
      this.recordedChunks = [];
      return;
    }
    const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'm4a' : 'webm';
    const blob = new Blob(this.recordedChunks, { type: mimeType.split(';')[0] || 'audio/webm' });
    this.recordedChunks = [];
    const room = this.selectedRoom();
    if (!room || blob.size === 0) return;
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type });
    this.uploadingFiles.set(true);
    try {
      await this.chatService.sendMessageWithAttachments(room._id, '', [file], 'voice');
    } catch (err: any) {
      this.toast.error(err?.error?.message || 'Failed to send voice message');
    } finally {
      this.uploadingFiles.set(false);
    }
  }

  handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessage();
    } else {
      this.emitTyping();
    }
  }

  // ── Edit message ───────────────────────────────────────
  startEdit(msg: BackendMessage) {
    this.editingMsgId.set(msg._id);
    this.editingText.set(msg.content);
  }

  cancelEdit() {
    this.editingMsgId.set(null);
    this.editingText.set('');
  }

  async saveEdit() {
    const msgId = this.editingMsgId();
    const room = this.selectedRoom();
    if (!msgId || !room) return;

    const text = this.editingText().trim();
    if (!text) return;

    if (this.socket) {
      this.socket.emit('edit_message', {
        roomId: room._id,
        messageId: msgId,
        content: text,
      });
    } else {
      const ok = await this.chatService.editMessage(room._id, msgId, text);
      if (ok) {
        this.messages.update(msgs =>
          msgs.map(m => m._id === msgId ? { ...m, content: text, edited: true } : m)
        );
      }
    }
    this.cancelEdit();
  }

  // ── Delete message ─────────────────────────────────────
  async deleteMessage(msgId: string) {
    const room = this.selectedRoom();
    if (!room) return;

    if (this.socket) {
      this.socket.emit('delete_message', {
        roomId: room._id,
        messageId: msgId,
        deleteType: 'everyone',
      });
    } else {
      const ok = await this.chatService.deleteMessage(room._id, msgId);
      if (ok) {
        this.messages.update(msgs => msgs.filter(m => m._id !== msgId));
      }
    }
  }

  // ── Reactions ──────────────────────────────────────────
  toggleReactionMenu(msgId: string) {
    this.reactionMenuMsgId.set(
      this.reactionMenuMsgId() === msgId ? null : msgId
    );
  }

  async addReaction(msgId: string, emoji: string) {
    const room = this.selectedRoom();
    if (!room) return;

    // Optimistic update
    this.messages.update(msgs =>
      msgs.map(m => {
        if (m._id !== msgId) return m;
        const existing = m.reactions ?? [];
        return {
          ...m,
          reactions: [...existing, { emoji, userId: this.currentUser?._id ?? '', username: this.currentUser?.username }]
        };
      })
    );

    this.reactionMenuMsgId.set(null);
    await this.chatService.addReaction(room._id, msgId, emoji);
  }

  // Group reactions for display: { emoji, count, hasMyReaction }
  getGroupedReactions(msg: BackendMessage): { emoji: string; count: number; mine: boolean }[] {
    if (!msg.reactions?.length) return [];
    const myId = this.currentUser?._id;
    const map = new Map<string, { count: number; mine: boolean }>();

    for (const r of msg.reactions) {
      const emoji = typeof r === 'string' ? r : r.emoji;
      const userId = typeof r === 'string' ? '' : r.userId;
      const existing = map.get(emoji) ?? { count: 0, mine: false };
      existing.count++;
      if (userId === myId) existing.mine = true;
      map.set(emoji, existing);
    }

    return [...map.entries()].map(([emoji, v]) => ({
      emoji, count: v.count, mine: v.mine,
    }));
  }

  // ── Pin / Save ─────────────────────────────────────────
  async togglePin(msgId: string) {
    const room = this.selectedRoom();
    if (!room) return;
    const pinned = this.pinnedMsgIds();
    if (pinned.has(msgId)) {
      await this.chatService.unpinMessage(room._id, msgId);
      this.pinnedMsgIds.update(s => { const n = new Set(s); n.delete(msgId); return n; });
      this.pinnedMessages.update(list => list.filter(m => m._id !== msgId));
    } else {
      await this.chatService.pinMessage(room._id, msgId);
      this.pinnedMsgIds.update(s => new Set([...s, msgId]));
      // Add the live message object to the banner list (newest first)
      const msg = this.messages().find(m => m._id === msgId);
      if (msg) this.pinnedMessages.update(list => [msg, ...list]);
    }
  }

  // Saved (bookmarked) — message can be saved or unsaved.
  async bookmarkMessage(msgId: string) {
    const room = this.selectedRoom();
    if (!room) return;
    await this.chatService.saveMessage(room._id, msgId);
    this.successFlash('Message saved');
  }

  isPinned(msgId: string): boolean {
    return this.pinnedMsgIds().has(msgId);
  }

  togglePinnedBanner() { this.showPinned.update(v => !v); }

  // ── Saved messages view ────────────────────────────────
  async openSaved() {
    this.showSaved.set(true);
    this.savedLoading.set(true);
    const items = await this.chatService.getSavedMessages();
    this.savedMessages.set(Array.isArray(items) ? items : []);
    this.savedLoading.set(false);
  }

  async unsave(item: any) {
    const roomId = item.chatRoomId?._id ?? item.chatRoomId;
    const messageId = item.messageId?._id ?? item.messageId;
    if (!roomId || !messageId) return;
    await this.chatService.unsaveMessage(roomId, messageId);
    this.savedMessages.update(list =>
      list.filter(x => (x.messageId?._id ?? x.messageId) !== messageId)
    );
  }

  // ── Mentions inbox ─────────────────────────────────────
  async openMentions() {
    this.showMentions.set(true);
    this.mentionsLoading.set(true);
    const items = await this.chatService.getMyMentions();
    this.mentions.set(Array.isArray(items) ? items : []);
    this.mentionsLoading.set(false);
  }

  // Jump from a saved/mention/pinned entry to the live message in its room.
  async jumpToMessage(roomId: string, messageId: string) {
    this.showSaved.set(false);
    this.showMentions.set(false);
    this.showPinned.set(false);
    const room = this.rooms().find(r => r._id === roomId);
    if (room && room._id !== this.selectedRoom()?._id) {
      await this.selectRoom(room);
    }
    // Give the list a tick to render, then scroll + flash the target.
    setTimeout(() => {
      const el = document.getElementById('msg-' + messageId);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        this.highlightedMsgId.set(messageId);
        setTimeout(() => this.highlightedMsgId.set(null), 2200);
      }
    }, 200);
  }

  // ── @mention rendering ─────────────────────────────────
  // Split message content into plain + mention segments so the template
  // can highlight "@username" without unsafe innerHTML.
  messageSegments(content: string): { text: string; mention: boolean }[] {
    if (!content) return [];
    const names = new Set(
      (this.selectedRoom()?.members ?? []).map(m => m.username.toLowerCase())
    );
    const out: { text: string; mention: boolean }[] = [];
    const re = /@([a-zA-Z0-9._-]+)/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const handle = m[1].toLowerCase();
      // Only highlight if it resolves to a real room member.
      if (!names.has(handle)) continue;
      if (m.index > last) out.push({ text: content.slice(last, m.index), mention: false });
      out.push({ text: m[0], mention: true });
      last = m.index + m[0].length;
    }
    if (last < content.length) out.push({ text: content.slice(last), mention: false });
    return out.length ? out : [{ text: content, mention: false }];
  }

  // ── @mention autocomplete (compose box) ────────────────
  onComposeInput(value: string) {
    this.messageText.set(value);
    this.emitTyping();

    // Detect an in-progress "@token" ending at the caret (we use end of
    // string as a good-enough caret proxy for a single-line input).
    const at = value.lastIndexOf('@');
    if (at === -1) { this.mentionMatches.set([]); this.mentionAnchor = -1; return; }
    const token = value.slice(at + 1);
    // Token must be a contiguous handle (no spaces) to stay "active".
    if (/\s/.test(token)) { this.mentionMatches.set([]); this.mentionAnchor = -1; return; }

    this.mentionAnchor = at;
    const q = token.toLowerCase();
    const myId = this.currentUser?._id;
    const matches = (this.selectedRoom()?.members ?? [])
      .filter(m => m._id !== myId && m.username.toLowerCase().includes(q))
      .slice(0, 6);
    this.mentionMatches.set(matches);
  }

  pickMention(username: string) {
    if (this.mentionAnchor < 0) return;
    const text = this.messageText();
    const next = text.slice(0, this.mentionAnchor) + '@' + username + ' ';
    this.messageText.set(next);
    this.mentionMatches.set([]);
    this.mentionAnchor = -1;
  }

  private successFlash(_msg: string) { /* lightweight no-op hook for toast */ }

  // ── Channel Tabs ───────────────────────────────────────
  async loadTabs(roomId: string) {
    const tabs = await this.chatService.getTabs(roomId);
    this.roomTabs.set(tabs);
  }

  async createTab() {
    const room = this.selectedRoom();
    if (!room || !this.newTabName().trim()) return;
    this.addingTab.set(true);
    const tab = await this.chatService.createTab(room._id, this.newTabName().trim(), this.newTabType());
    if (tab) {
      this.roomTabs.update(list => [...list, tab]);
      this.newTabName.set('');
      this.showAddTab.set(false);
    }
    this.addingTab.set(false);
  }

  async removeTab(tabId: string) {
    const room = this.selectedRoom();
    if (!room) return;
    const ok = await this.chatService.deleteTab(room._id, tabId);
    if (ok) {
      this.roomTabs.update(list => list.filter(t => t._id !== tabId));
    }
  }

  startEditTab(tab: any) {
    this.editingTabId.set(tab._id);
    this.editingTabName.set(tab.name);
  }

  async saveEditTab() {
    const room = this.selectedRoom();
    const tabId = this.editingTabId();
    const name = this.editingTabName().trim();
    if (!room || !tabId || !name) return;
    this.savingTabEdit.set(true);
    const ok = await this.chatService.updateTab(room._id, tabId, { name });
    if (ok) {
      this.roomTabs.update(list =>
        list.map(t => t._id === tabId ? { ...t, name } : t)
      );
    }
    this.editingTabId.set(null);
    this.savingTabEdit.set(false);
  }

  cancelEditTab() {
    this.editingTabId.set(null);
    this.editingTabName.set('');
  }

  // ── Search ──────────────────────────────────────────────
  async runSearch() {
    const room = this.selectedRoom();
    const q = this.msgSearchQuery().trim();
    if (!room || !q) return;
    this.searching.set(true);
    const results = await this.chatService.searchMessages(room._id, q);
    this.searchResults.set(results);
    this.searching.set(false);
  }
  clearSearch() { this.showSearch.set(false); this.msgSearchQuery.set(''); this.searchResults.set([]); }

  // ── AI summarize ─────────────────────────────────────────
  toggleSummarizePanel() {
    const next = !this.showSummarize();
    this.showSummarize.set(next);
    if (!next) {
      this.summarizeResult.set(null);
    }
  }

  async runSummarize() {
    const room = this.selectedRoom();
    if (!room) return;

    this.summarizing.set(true);
    this.summarizeResult.set(null);
    try {
      const window = this.summarizeWindow();
      const result = await this.chatService.summarizeRoom(room._id, {
        ...(window ? { window } : {}),
        includeVoiceAnalysis: this.summarizeIncludeVoice(),
        includeImageOcr: this.summarizeIncludeImage(),
      });
      this.summarizeResult.set(result);
    } catch (err: any) {
      this.toast.error(err?.error?.message || 'Failed to summarize chat');
    } finally {
      this.summarizing.set(false);
    }
  }

  // ── Forward ─────────────────────────────────────────────
  async doForward() {
    const targetId = this.forwardTargetId();
    const msgId = this.forwardingMsgId();
    if (!targetId || !msgId) return;
    this.forwarding.set(true);
    await this.chatService.forwardMessage(targetId, msgId);
    this.forwardingMsgId.set(null);
    this.forwardTargetId.set('');
    this.forwarding.set(false);
  }

  // ── Thread ───────────────────────────────────────────────
  async openThread(msgId: string) {
    const room = this.selectedRoom();
    if (!room) return;
    this.threadMsgId.set(msgId);
    this.threadLoading.set(true);
    const msgs = await this.chatService.getThread(room._id, msgId);
    this.threadMsgs.set(msgs);
    this.threadLoading.set(false);
  }
  closeThread() { this.threadMsgId.set(null); this.threadMsgs.set([]); this.threadReply.set(''); }

  async sendThreadReply() {
    const room = this.selectedRoom();
    const msgId = this.threadMsgId();
    const content = this.threadReply().trim();
    if (!room || !msgId || !content) return;
    // Persist via REST with replyTo — the backend broadcasts receive_message
    // to the room (there is no 'new_message' socket handler on the server).
    this.threadReply.set('');
    await this.chatService.sendMessage(room._id, content, 'text', msgId);
    // Reload thread to show the new reply
    this.openThread(msgId);
  }

  // ── Scheduled messages ───────────────────────────────────
  async loadScheduled() {
    const room = this.selectedRoom();
    if (!room) return;
    this.showScheduled.set(true);
    const msgs = await this.chatService.getScheduledMessages(room._id);
    this.scheduledMessages.set(Array.isArray(msgs) ? msgs : []);
  }

  async scheduleMsg() {
    const room = this.selectedRoom();
    const content = this.scheduleContent().trim();
    const sendAt = this.scheduleSendAt();
    if (!room || !content || !sendAt) return;
    this.scheduling.set(true);
    const ok = await this.chatService.scheduleMessage(room._id, content, new Date(sendAt).toISOString());
    if (ok) {
      this.scheduleContent.set(''); this.scheduleSendAt.set('');
      this.showScheduleForm.set(false);
      await this.loadScheduled();
    }
    this.scheduling.set(false);
  }

  async deleteScheduled(scheduledId: string) {
    const room = this.selectedRoom();
    if (!room) return;
    await this.chatService.deleteScheduledMessage(room._id, scheduledId);
    this.scheduledMessages.update(list => list.filter(m => m._id !== scheduledId));
  }

  // ── Calls ───────────────────────────────────────────────
  // The global CallOverlayComponent (mounted in the dashboard shell) owns the
  // incoming-call banner, the active-call panel, and LiveKit video binding.
  // This component only kicks off a call for the selected room; the overlay
  // takes over once SocketService reports the call is live.
  async startOrJoinCall(type: 'video' | 'voice' = 'video') {
    const room = this.selectedRoom();
    if (!room) return;
    const active = this.activeCallInfo();
    if (active?._id) {
      // Join the already-running call in this room — overlay binds the video.
      this.socketService.activeCall.set({ callId: active._id, roomId: room._id });
      await this.callService.joinCall(room._id, active._id);
      return;
    }
    // Start a new call. Backend replies 'call:initiated' → SocketService joins.
    this.socketService.emitCall('call:initiate', { roomId: room._id, type });
  }

  async loadCallHistory() {
    const room = this.selectedRoom();
    if (!room) return;
    const hist = await this.callService.getCallHistory(room._id);
    this.callHistory.set(hist);
    this.showCallHistory.set(true);
  }

  async downloadRecording(call: any) {
    const room = this.selectedRoom();
    if (!room || !call?._id) return;
    const url = await this.callService.getRecordingDownloadUrl(room._id, call._id);
    if (url) {
      window.open(url, '_blank', 'noopener');
    }
  }

  callDuration(call: any): string {
    if (!call.startedAt || !call.endedAt) return '—';
    const s = Math.round((new Date(call.endedAt).getTime() - new Date(call.startedAt).getTime()) / 1000);
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}m ${sec}s`;
  }

  // ── Typing indicator ───────────────────────────────────
  private emitTyping() {
    const room = this.selectedRoom();
    if (!room || !this.socket) return;
    this.socket.emit('typing', { roomId: room._id });
    clearTimeout(this.typingTimeout);
    this.typingTimeout = setTimeout(() => {
      this.socket?.emit('stop_typing', { roomId: room._id });
    }, 2000);
  }

  // ── Create DM ──────────────────────────────────────────
  async createDM(targetUserId: string) {
    const room = await this.chatService.createDM(targetUserId);
    if (room) {
      // Add to list if not already there
      if (!this.rooms().find(r => r._id === room._id)) {
        this.rooms.update(r => [...r, room]);
      }
      this.selectRoom(room);
    }
    this.showCreateDM.set(false);
  }

  // ── Browse / Join channels ─────────────────────────────
  async openBrowseChannels() {
    this.showBrowseChannels.set(true);
    await this.loadBrowseChannels();
  }

  async loadBrowseChannels() {
    this.browseLoading.set(true);
    const channels = await this.chatService.browseChannels(this.orgId, this.browseSearch());
    this.browseResults.set(channels);
    this.browseLoading.set(false);
  }

  async joinChannel(channelId: string) {
    this.joiningChannelId.set(channelId);
    const room = await this.chatService.joinChannel(channelId);
    this.joiningChannelId.set(null);
    if (room) {
      // Add to rooms list and select it
      if (!this.rooms().find(r => r._id === room._id)) {
        this.rooms.update(r => [...r, room]);
      }
      this.showBrowseChannels.set(false);
      this.selectRoom(room);
    }
  }

  // ── Leave room ─────────────────────────────────────────
  async leaveCurrentRoom() {
    const room = this.selectedRoom();
    if (!room) return;
    if (room.type === 'direct') return; // can't leave DMs
    const ok = await this.chatService.leaveRoom(room._id);
    if (ok) {
      this.rooms.update(r => r.filter(x => x._id !== room._id));
      this.selectedRoom.set(null);
      this.messages.set([]);
    }
  }

  // ── Add member to room ─────────────────────────────────
  get addMemberCandidates() {
    const room = this.selectedRoom();
    if (!room) return [];
    const memberIds = new Set(room.members.map((m: any) => m._id));
    const q = this.addMemberQuery().toLowerCase();
    return this.orgMembers().filter(m =>
      !memberIds.has(m._id) &&
      (m.username.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
    );
  }

  async addMemberToRoom(memberId: string) {
    const room = this.selectedRoom();
    if (!room) return;
    this.addingMemberId.set(memberId);
    const ok = await this.chatService.addMemberToRoom(room._id, memberId);
    this.addingMemberId.set(null);
    if (ok) {
      // Refresh room details
      const member = this.orgMembers().find(m => m._id === memberId);
      if (member) {
        this.selectedRoom.update(r => r ? {
          ...r,
          members: [...r.members, { _id: member._id, username: member.username, email: member.email, image: member.image }]
        } : r);
      }
      this.showAddMember.set(false);
    }
  }

  // ── Create channel ─────────────────────────────────────
  async createChannel() {
    const name = this.newChannelName().trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;

    const room = await this.chatService.createChannel(name);
    if (room) {
      this.rooms.update(r => [...r, room]);
      this.selectRoom(room);
    }
    this.newChannelName.set('');
    this.showCreateChannel.set(false);
  }

  // ── Create group ───────────────────────────────────────
  async createGroup() {
    const name = this.newGroupName().trim();
    const memberIds = this.selectedGroupMembers();
    if (!name || memberIds.length === 0) return;

    const room = await this.chatService.createGroup(name, memberIds);
    if (room) {
      this.rooms.update(r => [...r, room]);
      this.selectRoom(room);
    }
    this.newGroupName.set('');
    this.selectedGroupMembers.set([]);
    this.showCreateGroup.set(false);
  }

  toggleGroupMember(id: string) {
    this.selectedGroupMembers.update(ids =>
      ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]
    );
  }

  // ── Socket.IO ──────────────────────────────────────────
  private connectSocket() {
    const token = this.auth.token();
    if (!token) return;

    try {
      import('socket.io-client').then(({ io }) => {
        this.socket = io(`${SOCKET_BASE}/chat`, {
          auth: { authorization: `Bearer ${token}` },
          transports: ['websocket', 'polling'],
        });

        this.socket.on('connect', () => {
          console.log('[Socket] Chat connected');
          const room = this.selectedRoom();
          if (room) this.socket.emit('join_room', { roomId: room._id });
        });

        this.socket.on('receive_message', ({ message }: { message: BackendMessage }) => {
          const room = this.selectedRoom();
          if (message.chatRoomId === room?._id) {
            if (!this.messages().find(m => m._id === message._id)) {
              this.messages.update(msgs => [...msgs, message]);
              this.shouldScroll = true;
            }
            // Auto mark as seen
            this.chatService.markSeen(room._id, message._id);
          }
          // Update room's lastMessage
          this.rooms.update(rooms =>
            rooms.map(r =>
              r._id === message.chatRoomId
                ? { ...r, lastMessage: message, lastMessageAt: message.createdAt }
                : r
            )
          );
        });

        this.socket.on('message_sent', ({ message }: { message: BackendMessage }) => {
          const room = this.selectedRoom();
          if (message.chatRoomId === room?._id) {
            // Avoid duplicate — check if already in list
            if (!this.messages().find(m => m._id === message._id)) {
              this.messages.update(msgs => [...msgs, message]);
              this.shouldScroll = true;
            }
          }
        });

        this.socket.on('user_typing', ({ userId, username }: any) => {
          if (userId !== this.currentUser?._id) {
            this.typingUsers.update(u => u.includes(username) ? u : [...u, username]);
          }
        });

        this.socket.on('user_stopped_typing', ({ username }: any) => {
          this.typingUsers.update(u => u.filter(x => x !== username));
        });

        this.socket.on('room_created', ({ room }: { room: Conversation }) => {
          if (!this.rooms().find(r => r._id === room._id)) {
            this.rooms.update(r => [...r, room]);
          }
        });

        this.socket.on('message_edited', ({ messageId, content }: any) => {
          this.messages.update(msgs =>
            msgs.map(m => m._id === messageId ? { ...m, content, edited: true } : m)
          );
        });

        this.socket.on('message_deleted', ({ messageId, deleteType }: any) => {
          if (deleteType === 'everyone') {
            this.messages.update(msgs => msgs.filter(m => m._id !== messageId));
          }
        });

        this.socket.on('reaction_added', ({ messageId, reaction }: any) => {
          this.messages.update(msgs =>
            msgs.map(m => {
              if (m._id !== messageId) return m;
              const reactions = [...(m.reactions ?? []), reaction];
              return { ...m, reactions };
            })
          );
        });

        this.socket.on('reaction_removed', ({ messageId, userId }: any) => {
          this.messages.update(msgs =>
            msgs.map(m => {
              if (m._id !== messageId) return m;
              const reactions = (m.reactions ?? []).filter((r: any) =>
                (typeof r === 'string' ? false : r.userId !== userId)
              );
              return { ...m, reactions };
            })
          );
        });

        this.socket.on('disconnect', () => console.log('[Socket] Chat disconnected'));
        this.socket.on('socket_Error', (err: any) => console.error('[Socket] Error:', err));
      }).catch(() => {
        console.warn('[Messages] socket.io-client not installed — using REST only');
      });
    } catch { /* socket.io-client not available */ }
  }

  private disconnectSocket() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    clearTimeout(this.typingTimeout);
  }
}