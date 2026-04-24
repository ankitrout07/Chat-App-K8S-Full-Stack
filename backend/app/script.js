const socket = io({ autoConnect: false });

// Cache common DOM elements for performance
const DOM = {
    messages: document.getElementById('messages'),
    input: document.getElementById('input'),
    activeRoom: document.getElementById('active-room-display'),
    sidebarUsers: document.getElementById('sidebar-users'),
    authNav: document.getElementById('auth-nav'),
    loginBtn: document.getElementById('login-btn'),
    navUsername: document.getElementById('nav-username'),
    navStatusEmoji: document.getElementById('nav-status-emoji'),
    navStatusText: document.getElementById('nav-status-text'),
    userAvatarMini: document.getElementById('user-avatar-mini')
};
let onlineUserIds = new Set();
let allUsers = [];
let allGroups = [];
let currentRoom = 'general';
let currentGroupId = null;
let replyingTo = null; // { id, sender, text }

// Monitoring State
let msgFrequencyChart = null;
let frequencyData = Array(20).fill(0);
let frequencyLabels = Array(20).fill('');

const themes = {
    dark: { 
        '--bg-deep': '#050811', '--bg-main': '#0a0f1e', '--panel': 'rgba(16, 24, 39, 0.7)', 
        '--text-main': '#f1f5f9', '--accent': '#6366f1', '--accent-glow': 'rgba(99, 102, 241, 0.3)',
        '--bubble-me': '#6366f1', '--bubble-them': 'rgba(30, 41, 59, 0.8)' 
    },
    light: { 
        '--bg-deep': '#f1f5f9', '--bg-main': '#f8fafc', '--panel': 'rgba(255, 255, 255, 0.9)', 
        '--text-main': '#0f172a', '--accent': '#4f46e5', '--accent-glow': 'rgba(79, 70, 229, 0.2)',
        '--bubble-me': '#4f46e5', '--bubble-them': 'rgba(241, 245, 249, 1)' 
    },
    solar: { 
        '--bg-deep': '#00212b', '--bg-main': '#002b36', '--panel': 'rgba(7, 54, 66, 0.8)', 
        '--text-main': '#839496', '--accent': '#b58900', '--accent-glow': 'rgba(181, 137, 0, 0.3)',
        '--bubble-me': '#b58900', '--bubble-them': 'rgba(7, 54, 66, 1)' 
    },
    cyberpunk: {
        '--bg-deep': '#0c001a', '--bg-main': '#1a0033', '--panel': 'rgba(20, 0, 40, 0.7)', 
        '--text-main': '#00ffcc', '--accent': '#ff00ff', '--accent-glow': 'rgba(255, 0, 255, 0.4)',
        '--bubble-me': '#ff00ff', '--bubble-them': 'rgba(40, 0, 80, 0.8)'
    },
    space: {
        '--bg-deep': '#000000', '--bg-main': '#0a0a0a', '--panel': 'rgba(10, 10, 20, 0.8)', 
        '--text-main': '#ffffff', '--accent': '#0ea5e9', '--accent-glow': 'rgba(14, 165, 233, 0.3)',
        '--bubble-me': '#0ea5e9', '--bubble-them': 'rgba(20, 20, 30, 1)'
    },
    emerald: {
        '--bg-deep': '#010b01', '--bg-main': '#021a02', '--panel': 'rgba(2, 40, 20, 0.7)', 
        '--text-main': '#dcfce7', '--accent': '#10b981', '--accent-glow': 'rgba(16, 185, 129, 0.3)',
        '--bubble-me': '#10b981', '--bubble-them': 'rgba(5, 50, 30, 0.8)'
    }
};

const SVGS = {
    sent: `<svg class="receipt-icon receipt-sent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    delivered: `<svg class="receipt-icon receipt-delivered" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 6 7 17 2 12"></polyline><polyline points="22 6 12.5 15.5"></polyline></svg>`,
    read: `<svg class="receipt-icon receipt-read" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 6 7 17 2 12"></polyline><polyline points="22 6 12.5 15.5"></polyline></svg>`
};

function applyTheme(name) {
    const themeData = themes[name] || themes.dark;
    
    // Apply CSS variables to root
    const root = document.documentElement;
    Object.entries(themeData).forEach(([prop, value]) => {
        root.style.setProperty(prop, value);
    });

    const themeClasses = ['dark', 'light', 'solar', 'cyberpunk', 'space', 'emerald'].map(t => 'theme-' + t);
    
    // Remove existing theme classes
    themeClasses.forEach(c => document.body.classList.remove(c));
    
    // Add new theme class
    const newClass = 'theme-' + name;
    document.body.classList.add(newClass);
    
    localStorage.setItem('chat-theme', name);
    
    // Persist to DB if logged in
    if (authUser && socket.connected) {
        socket.emit('updateThemePreference', { theme: name });
    }
    
    toast(`Protocol: ${name.toUpperCase()}`);
}


let currentUser = null;
let authUser = JSON.parse(localStorage.getItem('tunnel_auth_user') || 'null');
let authToken = localStorage.getItem('tunnel_auth_token') || null;
let typingTimeout;
let monitoringInterval;
let authMode = 'login'; 
const GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com"; // User should replace this

const popSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
popSound.volume = 0.5;

// --- AUTH LOGIC ---
function openAuthModal() { document.getElementById('auth-modal').classList.remove('hidden'); }
function closeAuthModal() { document.getElementById('auth-modal').classList.add('hidden'); }
function toggleAuthMode() {
    authMode = authMode === 'login' ? 'register' : 'login';
    document.getElementById('auth-title').innerText = authMode === 'login' ? 'Login' : 'Register';
    document.getElementById('auth-subtitle').innerText = authMode === 'login' ? 'Ready to resume your encrypted tunnel?' : 'Create a new persistent identity.';
    document.getElementById('auth-toggle-btn').innerText = authMode === 'login' ? 'Register' : 'Login';
    document.getElementById('auth-toggle-text').innerText = authMode === 'login' ? 'New to TunnelPro?' : 'Already have an account?';
}

function updateAuthUI() {
    if (authUser) {
        if (DOM.authNav) DOM.authNav.classList.remove('hidden');
        if (DOM.loginBtn) DOM.loginBtn.classList.add('hidden');
        if (DOM.navUsername) DOM.navUsername.innerText = authUser.username;
        
        if (DOM.userAvatarMini) {
            if (authUser.avatar_url) {
                DOM.userAvatarMini.innerHTML = `<img src="${authUser.avatar_url}" class="w-full h-full rounded-xl object-cover shadow-inner">`;
            } else {
                DOM.userAvatarMini.innerText = authUser.username[0].toUpperCase();
                DOM.userAvatarMini.style.background = 'var(--accent)';
            }
        }
        
        currentUser = authUser.username;
        
        // Restore theme and status from profile
        if (authUser.preferred_theme) {
            applyTheme(authUser.preferred_theme);
        }
        if (DOM.navStatusEmoji) DOM.navStatusEmoji.innerText = authUser.status_emoji || '🟢';
        if (DOM.navStatusText) DOM.navStatusText.innerText = authUser.status_text || 'Available';
    } else {
        if (DOM.authNav) DOM.authNav.classList.add('hidden');
        if (DOM.loginBtn) DOM.loginBtn.classList.remove('hidden');
        currentUser = null;
    }
}

function connectSocket() {
    if (!authToken) return;
    socket.auth = { token: authToken };
    socket.connect();
    
    // Initial room join
    setTimeout(async () => {
        await fetchGroups();
        const generalGroup = allGroups.find(g => g.name === 'general');
        joinRoom('general', generalGroup?.id || null);
    }, 500);
}

function logout() {
    localStorage.removeItem('tunnel_auth_token');
    localStorage.removeItem('tunnel_auth_user');
    socket.disconnect();
    authUser = null; authToken = null;
    updateAuthUI();
    toast('Logged out');
    fetchAndRenderUsers();
}

// --- GOOGLE AUTH ---
function initGoogleAuth() {
    if (typeof google === 'undefined') return setTimeout(initGoogleAuth, 100);
    
    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCallback
    });
    
    // We render the standard button into a hidden div so we can trigger it if needed,
    // or just use it for the One Tap experience.
    google.accounts.id.renderButton(
        document.getElementById("google-login-btn-hidden"),
        { theme: "outline", size: "large", width: 320 }
    );
}

function triggerGoogleLogin() {
    // This will trigger the Google Login popup/prompt
    google.accounts.id.prompt();
}

async function handleGoogleCallback(response) {
    try {
        const res = await fetch('/auth/google', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential: response.credential })
        });
        
        const data = await res.json();
        if (res.ok) {
            localStorage.setItem('tunnel_auth_token', data.token);
            localStorage.setItem('tunnel_auth_user', JSON.stringify(data.user));
            authUser = data.user;
            authToken = data.token;
            
            closeAuthModal();
            updateAuthUI();
            connectSocket();
            toast(`Welcome, ${authUser.username}`);
            fetchAndRenderUsers();
        } else {
            toast(data.error || 'Google login failed');
        }
    } catch (err) {
        console.error('Google Auth Error:', err);
        toast('Network error during Google login');
    }
}

// --- FILE UPLOAD LOGIC ---
async function uploadFile(input) {
    if (!input.files[0]) return;
    const formData = new FormData();
    formData.append('file', input.files[0]);
    try {
        const res = await fetch('/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.url) {
            const text = data.url.match(/\.(jpeg|jpg|gif|png|webp)$/i) 
                ? data.url 
                : `📁 Attachment: [${data.name}](${data.url})`;
            socket.emit('chat message', { 
                user: currentUser || 'Guest', 
                userId: authUser ? authUser.id : null,
                text: text,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                room: currentRoom
            });
        }
    } catch (err) { toast('Upload failed'); }
    input.value = '';
}

// --- GROUP MANAGEMENT ---
function openGroupModal() {
    if (!authUser) return toast('Login to create channels');
    document.getElementById('group-modal').classList.remove('hidden');
    document.getElementById('group-name-input').value = '';
    document.getElementById('group-error').classList.add('hidden');
    setTimeout(() => document.getElementById('group-name-input').focus(), 100);
}

function closeGroupModal() {
    document.getElementById('group-modal').classList.add('hidden');
}

async function handleCreateGroup(e) {
    e.preventDefault();
    const nameInput = document.getElementById('group-name-input');
    const errorEl = document.getElementById('group-error');
    const submitBtn = document.getElementById('group-submit-btn');
    const submitText = document.getElementById('group-submit-text');
    const spinner = document.getElementById('group-submit-spinner');
    const name = nameInput.value.trim();
    if (!name) return;

    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitText.textContent = 'Creating...';
    spinner.classList.remove('hidden');

    try {
        const res = await fetch('/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, createdBy: currentUser })
        });
        const data = await res.json();
        if (res.ok) {
            closeGroupModal();
            toast(`Channel #${data.name} created`);
            await fetchGroups();
            joinRoom(data.name, data.id);
        } else {
            errorEl.textContent = data.error || 'Failed to create channel';
            errorEl.classList.remove('hidden');
        }
    } catch (err) {
        errorEl.textContent = 'Network error. Try again.';
        errorEl.classList.remove('hidden');
    } finally {
        submitBtn.disabled = false;
        submitText.textContent = 'Create Channel';
        spinner.classList.add('hidden');
    }
}

async function fetchGroups() {
    try {
        const res = await fetch('/groups');
        allGroups = await res.json();
        renderGroups();
    } catch (e) {
        console.error('Error fetching groups:', e);
    }
}

function renderGroups() {
    const list = document.getElementById('group-list');
    if (!list) return;

    const icons = {
        'general': 'fa-hashtag',
        'dev-ops': 'fa-code-branch',
        'k8s-logs': 'fa-terminal',
        'default': 'fa-hashtag'
    };

    list.innerHTML = allGroups.map(g => {
        const icon = icons[g.name] || icons['default'];
        const isActive = currentRoom === g.name;
        return `
        <div class="sidebar-item ${isActive ? 'active' : ''}" data-room="${g.name}" data-group-id="${g.id}" onclick="joinRoom('${g.name}', ${g.id})">
            <i class="fas ${icon} text-xs"></i>
            <span class="flex-grow truncate">${g.name}</span>
            ${g.created_by !== 'system' ? `<button onclick="event.stopPropagation(); deleteGroup(${g.id}, '${g.name}')" class="opacity-0 group-hover:opacity-100 text-white/20 hover:text-red-400 transition-all text-[10px] p-1"><i class="fas fa-trash-alt"></i></button>` : ''}
        </div>`;
    }).join('');
}

async function deleteGroup(id, name) {
    if (!confirm(`Delete channel #${name}? All messages in this channel will be lost.`)) return;
    try {
        const res = await fetch(`/groups/${id}`, { method: 'DELETE' });
        if (res.ok) {
            socket.emit('group:delete', { id, name });
            toast(`Channel #${name} deleted`);
            await fetchGroups();
        }
    } catch (err) {
        toast('Failed to delete channel');
    }
}

// --- INVITE LOGIC ---
function openInviteModal() {
    if (!currentGroupId) return toast('Join a group channel to invite members');
    document.getElementById('invite-group-name').innerText = '#' + currentRoom;
    const select = document.getElementById('invite-user-select');
    select.innerHTML = allUsers
        .filter(u => u.id !== authUser?.id)
        .map(u => `<option value="${u.id}">${u.username}</option>`)
        .join('');
    
    document.getElementById('invite-modal').classList.remove('hidden');
}

function closeInviteModal() {
    document.getElementById('invite-modal').classList.add('hidden');
}

function sendInvite() {
    const select = document.getElementById('invite-user-select');
    const targetUserId = parseInt(select.value);
    const targetUsername = select.options[select.selectedIndex].text;

    socket.emit('addMemberToGroup', {
        groupId: currentGroupId,
        groupName: currentRoom,
        targetUserId,
        targetUsername
    });
    
    closeInviteModal();
    toast(`Invite sent to ${targetUsername}`);
}

// --- CORE CHAT LOGIC ---
function sendMessage() {
    const inputDom = document.getElementById('input');
    if (inputDom.value) {
        if (editingMsgId) {
            socket.emit('editRequest', { msgId: editingMsgId, newText: inputDom.value });
            cancelEdit();
            return;
        }
        
        const payload = { 
            user: currentUser || 'Guest', 
            userId: authUser ? authUser.id : null,
            text: inputDom.value, 
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            room: currentRoom,
            groupId: currentGroupId,
            parentId: replyingTo ? replyingTo.id : null
        };
        
        socket.emit('chat message', payload);
        inputDom.value = '';
        cancelReply();
        socket.emit('typing', { user: currentUser, isTyping: false, room: currentRoom });
    }
}

function setReply(msgId, sender, text) {
    replyingTo = { id: msgId, sender, text };
    document.getElementById('reply-user').innerText = sender;
    document.getElementById('reply-text').innerText = text;
    document.getElementById('reply-preview').classList.remove('hidden');
    document.getElementById('input').focus();
}

function cancelReply() {
    replyingTo = null;
    document.getElementById('reply-preview').classList.add('hidden');
}

function parseMessageContent(text) {
    if (!text) return '';
    let div = document.createElement('div');
    div.innerText = text;
    let html = div.innerHTML;

    html = html.replace(/\*\*(.*?)\*\*/g, '<span class="markdown-bold">$1</span>');
    html = html.replace(/\*(.*?)\*/g, '<span class="markdown-italic">$1</span>');
    html = html.replace(/`(.*?)`/g, '<span class="markdown-code">$1</span>');

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    html = html.replace(urlRegex, (url) => {
        if(url.match(/\.(jpeg|jpg|gif|png|webp)$/i)) {
            return `<br><img src="${url}" class="chat-image" loading="lazy" onclick="window.open('${url}','_blank')">`;
        }
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
    });
    // Convert newlines to <br> for bot multi-line responses
    html = html.replace(/\n/g, '<br>');
    return html;
}

function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.style.display = 'none'), 1800);
}

// Function to create a Quantum Toast (Stackable)
function showNotification(data) {
    const stack = document.getElementById('notification-stack');
    if (!stack) return;

    const toast = document.createElement('div');
    toast.className = 'quantum-toast glass p-4';
    
    const isBot = data.isBot || data.sender === 'TunnelBot';
    const borderCol = isBot ? 'var(--accent-secondary)' : 'var(--accent)';

    toast.innerHTML = `
        <div class="flex items-start gap-4" style="border-left: 4px solid ${borderCol}; padding-left: 12px;">
            <div class="flex-grow">
                <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] font-black uppercase tracking-widest text-white/90">${data.sender}</span>
                    ${isBot ? '<span class="text-[8px] px-1.5 py-0.5 rounded-md bg-cyan-500/20 text-cyan-400 font-black">BOT</span>' : ''}
                </div>
                <p class="text-[11px] leading-relaxed text-white/60 font-medium">${data.text.substring(0, 80)}${data.text.length > 80 ? '...' : ''}</p>
            </div>
        </div>
    `;

    stack.prepend(toast); // Newest at top of stack

    // Auto-vanish after 5 seconds
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(50px) scale(0.95)';
        setTimeout(() => toast.remove(), 500);
    }, 5000);
}

function requestNotifyPermission() {
    if (window.Notification && Notification.permission !== 'granted') {
        Notification.requestPermission();
    }
}


function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    const viewEl = document.getElementById('view-' + viewId);
    if(viewEl) viewEl.classList.remove('hidden');

    document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
    const sideEl = document.getElementById('nav-' + viewId);
    if (sideEl) sideEl.classList.add('active');

    if (viewId === 'monitor') {
        fetchStats();
        monitoringInterval = setInterval(fetchStats, 3000);
    } else {
        clearInterval(monitoringInterval);
    }
}

function joinRoom(room, groupId) {
    currentRoom = room;
    currentGroupId = groupId || null;
    socket.emit('join room', room);
    socket.emit('joinGroup', room);
    document.getElementById('messages').innerHTML = '';
    offset = 0;
    loadMessages();
    socket.emit('fetchPinnedMessages', room);
    showView('home');
    
    document.getElementById('active-room-display').innerText = room;
    document.getElementById('chat-header-icon').innerText = room.startsWith('dm_') ? '@' : '#';
    
    const inviteBtn = document.getElementById('invite-btn');
    if (inviteBtn) {
        inviteBtn.style.display = room.startsWith('dm_') ? 'none' : 'flex';
    }
    
    document.querySelectorAll('.sidebar-item').forEach(el => {
        const roomAttr = el.getAttribute('data-room');
        el.classList.toggle('active', roomAttr === room);
    });
}

async function fetchAndRenderUsers() {
    try {
        const res = await fetch('/users');
        allUsers = await res.json();
        renderUsers();
    } catch (e) { console.error('Error fetching users', e); }
}

function renderUsers() {
    const list = document.getElementById('sidebar-users');
    if (!list) return;
    const otherUsers = allUsers.filter(u => u.username !== currentUser);
    list.innerHTML = otherUsers.map(u => {
        const onlineData = Array.from(onlineUserIds).find(o => o.userId === u.id);
        const isOnline = !!onlineData;
        const room = getDMId(authUser ? authUser.id : 0, u.id);
        
        return `
        <div class="sidebar-item group" data-room="${room}" data-user-id="${u.id}" onclick="joinRoom('${room}')">
            <div class="relative">
                <div class="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-[10px] font-black border border-white/5 group-hover:border-indigo-500/30 transition-all overflow-hidden">
                    ${u.avatar_url ? `<img src="${u.avatar_url}" class="w-full h-full object-cover">` : u.username[0].toUpperCase()}
                </div>
                ${isOnline ? '<div class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-bg-deep shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>' : ''}
            </div>
            <div class="flex flex-col min-w-0">
                <div class="flex items-center gap-1.5">
                    <span class="truncate text-xs font-bold ${isOnline ? 'text-white/80' : 'text-white/30'}">${u.username}</span>
                    <span class="text-[9px] opacity-60">${u.status_emoji || '🟢'}</span>
                </div>
                <span class="text-[8px] text-muted truncate opacity-40">${u.status_text || 'Available'}</span>
            </div>
        </div>`;
    }).join('');
}

function getDMId(id1, id2) {
    return `dm_${Math.min(id1, id2)}_${Math.max(id1, id2)}`;
}

// --- MESSAGE RENDERING ---
function addReaction(messageId, emoji) {
    if (!authUser) return toast('Login to react');
    socket.emit('reaction', { messageId, userId: authUser.id, username: authUser.username, emoji });
}

function renderReactions(msgId, reactions) {
    if (!reactions || !reactions.length) return '';
    const groups = reactions.reduce((acc, r) => {
        acc[r.emoji] = (acc[r.emoji] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(groups).map(([emoji, count]) => `
        <div class="bg-slate-900/50 rounded-full px-2 py-0.5 border border-white/5 text-[10px] flex items-center gap-1">
            <span>${emoji}</span><span>${count}</span>
        </div>
    `).join('');
}

function deleteMessage(msgId) { socket.emit('deleteRequest', msgId); }

function updateMessageCount() {
    const count = document.querySelectorAll('#messages .relative').length;
    const mc = document.getElementById('msg-count');
    if(mc) mc.innerText = `${count} msgs`;
}

// --- EDIT & PIN LOGIC ---
let editingMsgId = null;

function startEdit(msgId, text) {
    editingMsgId = msgId;
    const input = document.getElementById('input');
    input.value = text;
    input.classList.add('editing-active');
    input.placeholder = "Editing message... (Esc to cancel)";
    input.focus();
    
    // Add visual indicator for editing
    document.querySelector('.chat-input-container').style.borderColor = 'var(--accent-secondary)';
}

function cancelEdit() {
    editingMsgId = null;
    const input = document.getElementById('input');
    input.value = '';
    input.classList.remove('editing-active');
    input.placeholder = "Transmit secure message...";
    document.querySelector('.chat-input-container').style.borderColor = 'rgba(255,255,255,0.05)';
}

function pinMessage(msgId) {
    socket.emit('pinRequest', msgId);
    toast('Pinning message...');
}

function unpinMessage(msgId) {
    socket.emit('unpinRequest', msgId);
    toast('Unpinning message...');
}

function renderPinnedMessages(messages) {
    const container = document.getElementById('pinned-messages');
    if (!container) return;
    
    if (messages.length === 0) {
        container.innerHTML = `<div class="text-[9px] text-muted opacity-30 italic text-center py-2">No active announcements</div>`;
        return;
    }
    
    container.innerHTML = messages.map(m => `
        <div class="p-3 rounded-xl bg-amber-500/5 border border-amber-500/10 hover:border-amber-500/30 transition-all cursor-pointer group relative overflow-hidden" onclick="jumpToMessage(${m.id})">
            <div class="absolute inset-0 bg-gradient-to-r from-amber-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <div class="flex justify-between items-start gap-2 relative z-10">
                <div class="flex flex-col min-w-0">
                    <span class="text-[8px] font-black uppercase text-amber-400 mb-1 tracking-widest">${m.sender}</span>
                    <p class="text-[10px] text-white/70 line-clamp-2 leading-relaxed">${m.text}</p>
                </div>
                <button onclick="event.stopPropagation(); unpinMessage(${m.id})" class="text-[8px] text-amber-500/40 hover:text-red-400 transition-colors"><i class="fas fa-times"></i></button>
            </div>
        </div>
    `).join('');
}

function jumpToMessage(id) {
    const el = document.getElementById('msg-' + id);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('quantum-glow');
        setTimeout(() => el.classList.remove('quantum-glow'), 4000);
    } else {
        toast('Message in deep storage. Decrypting history...');
        // Could implement auto-load here, but for now simple toast
    }
}

// Global Search Implementation
let searchDebounce;
async function performGlobalSearch(query, isSidebar = false) {
    if (!query || query.length < 2) {
        if (isSidebar) document.getElementById('search-results-overlay').classList.add('hidden');
        return;
    }
    
    try {
        const res = await fetch(`/search?q=${encodeURIComponent(query)}`);
        const results = await res.json();
        
        if (isSidebar) renderSidebarSearchResults(results);
    } catch (err) {
        console.error('Search failed:', err);
    }
}

function renderSidebarSearchResults(results) {
    const overlay = document.getElementById('search-results-overlay');
    const list = document.getElementById('search-results-list');
    
    if (results.length === 0) {
        list.innerHTML = '<div class="text-[10px] text-white/20 italic p-4 text-center">No matching transmissions found.</div>';
    } else {
        list.innerHTML = results.map(r => `
            <div class="search-result-item p-3 rounded-2xl cursor-pointer group flex gap-3 items-center" onclick="jumpToSearchResult(${r.id}, '${r.room}')">
                <div class="w-8 h-8 rounded-lg bg-white/5 flex-shrink-0 overflow-hidden flex items-center justify-center border border-white/10 group-hover:border-indigo-500/30 transition-all">
                    ${r.avatar_url ? `<img src="${r.avatar_url}" class="w-full h-full object-cover">` : `<span class="text-[10px] font-black">${r.sender[0].toUpperCase()}</span>`}
                </div>
                <div class="flex-grow min-w-0">
                    <div class="flex justify-between items-center mb-1">
                        <span class="text-[9px] font-black text-indigo-400 uppercase tracking-widest">${r.sender}</span>
                        <span class="text-[8px] text-white/10 group-hover:text-white/30 transition-colors uppercase font-bold">#${r.room}</span>
                    </div>
                    <p class="text-[10px] text-white/50 group-hover:text-white/80 transition-colors line-clamp-2 leading-relaxed">${r.text}</p>
                </div>
            </div>
        `).join('');
    }
    overlay.classList.remove('hidden');
}

async function jumpToSearchResult(id, room) {
    document.getElementById('search-results-overlay').classList.add('hidden');
    document.getElementById('sidebar-search').value = '';
    
    if (currentRoom !== room) {
        const group = allGroups.find(g => g.name === room);
        joinRoom(room, group?.id);
        // Wait for messages to load then jump
        setTimeout(() => jumpToMessage(id), 800);
    } else {
        jumpToMessage(id);
    }
}

function initCharts() {
    const ctx = document.getElementById('msgFrequencyChart');
    if (!ctx) return;

    msgFrequencyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: frequencyLabels,
            datasets: [{
                label: 'Messages / Minute',
                data: frequencyData,
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                borderWidth: 2,
                tension: 0.4,
                fill: true,
                pointRadius: 0,
                pointHitRadius: 10
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(5, 8, 17, 0.9)',
                    titleColor: '#6366f1',
                    bodyColor: '#fff',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 10,
                    titleFont: { size: 10, weight: 'bold' },
                    bodyFont: { size: 10 }
                }
            },
            scales: {
                x: { display: false },
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255,255,255,0.03)', drawBorder: false },
                    ticks: { 
                        color: 'rgba(255,255,255,0.2)', 
                        font: { size: 8, weight: 'bold' },
                        stepSize: 1
                    }
                }
            }
        }
    });
}

// --- PROFILE & HOVER CARD ---
function openProfileModal() {
    if (!authUser) return openAuthModal();
    const modal = document.getElementById('profile-modal');
    document.getElementById('profile-username').innerText = authUser.username;
    document.getElementById('profile-bio-input').value = authUser.bio || '';
    document.getElementById('profile-status-text').value = authUser.status_text || 'Available';
    document.getElementById('profile-status-emoji').value = authUser.status_emoji || '🟢';
    
    const avatarEl = document.getElementById('profile-avatar');
    if (authUser.avatar_url) {
        avatarEl.innerHTML = `<img src="${authUser.avatar_url}" class="w-full h-full rounded-3xl object-cover shadow-2xl">`;
    } else {
        avatarEl.innerText = authUser.username[0].toUpperCase();
        avatarEl.style.background = 'var(--accent)';
    }
    modal.classList.remove('hidden');
}

function closeProfileModal() {
    document.getElementById('profile-modal').classList.add('hidden');
}

function saveProfile() {
    const bio = document.getElementById('profile-bio-input').value;
    const statusText = document.getElementById('profile-status-text').value;
    const statusEmoji = document.getElementById('profile-status-emoji').value;
    
    socket.emit('updateBio', { bio });
    socket.emit('updateStatus', { text: statusText, emoji: statusEmoji });
    
    authUser.bio = bio;
    authUser.status_text = statusText;
    authUser.status_emoji = statusEmoji;
    
    localStorage.setItem('tunnel_auth_user', JSON.stringify(authUser));
    updateAuthUI();
    toast('Neural profile synchronized');
    closeProfileModal();
}

// Hover Card logic
let hoverTimeout;
document.addEventListener('mouseover', (e) => {
    const trigger = e.target.closest('.user-profile-trigger');
    if (trigger) {
        clearTimeout(hoverTimeout);
        const userId = trigger.dataset.userId;
        const username = trigger.innerText;
        showHoverCard(trigger, userId, username);
    }
});

document.addEventListener('mouseout', (e) => {
    if (e.target.closest('.user-profile-trigger')) {
        hoverTimeout = setTimeout(hideHoverCard, 300);
    }
});

function showHoverCard(trigger, userId, username) {
    const card = document.getElementById('user-hover-card');
    const rect = trigger.getBoundingClientRect();
    
    // Position card
    card.style.left = `${rect.left}px`;
    card.style.top = `${rect.top - 180}px`; // Adjust based on card height
    
    // Find user data
    const user = allUsers.find(u => u.id == userId || u.username === username);
    const isOnline = onlineUserIds.has(parseInt(userId));
    
    document.getElementById('hover-username').innerText = username === 'You' ? authUser.username : username;
    
    const avatarEl = document.getElementById('hover-avatar');
    const avatarUrl = user?.avatar_url || (username === 'You' ? authUser.avatar_url : null);
    
    if (avatarUrl) {
        avatarEl.innerHTML = `<img src="${avatarUrl}" class="w-full h-full rounded-2xl object-cover">`;
    } else {
        avatarEl.innerText = (username === 'You' ? authUser.username : username)[0].toUpperCase();
        avatarEl.style.background = 'var(--accent)';
    }
    
    document.getElementById('hover-bio').innerText = user?.bio || 'Neural interface active...';
    
    const statusDot = card.querySelector('.bg-emerald-500');
    const statusText = document.getElementById('hover-status');
    
    if (isOnline) {
        statusDot.className = 'w-1.5 h-1.5 bg-emerald-500 rounded-full shadow-[0_0_8px_rgba(16,185,129,0.5)]';
        statusText.innerHTML = `<span class="mr-1">${user?.status_emoji || '🟢'}</span> ${user?.status_text || 'Online'}`;
        statusText.className = 'text-[8px] font-bold text-emerald-400 uppercase tracking-widest';
    } else {
        statusDot.className = 'w-1.5 h-1.5 bg-white/20 rounded-full';
        statusText.innerText = 'Offline';
        statusText.className = 'text-[8px] font-bold text-white/20 uppercase tracking-widest';
    }

    card.style.opacity = '1';
    card.style.pointerEvents = 'auto';
    card.style.transform = 'translateY(0) scale(1)';
}

function hideHoverCard() {
    const card = document.getElementById('user-hover-card');
    card.style.opacity = '0';
    card.style.pointerEvents = 'none';
    card.style.transform = 'translateY(2px) scale(0.95)';
}

let offset = 0;
const limit = 50;
let fetching = false;

async function loadMessages(isLoadMore = false) {
    if (fetching) return;
    fetching = true;
    try {
        const res = await fetch(`/messages?limit=${limit}&offset=${offset}&room=${currentRoom}`);
        const data = await res.json();
        if (data.length === 0) {
            fetching = false;
            return;
        }

        if (isLoadMore) {
            // Prepend older messages at the top
            data.forEach(msg => prependMessage(msg, true));
        } else {
            // Initial load: append newest at the bottom
            data.reverse().forEach(msg => prependMessage(msg, false));
            scrollToBottom();
        }
        offset += data.length;
    } catch (e) { console.error('Error loading messages', e); }
    finally { fetching = false; }
}

function prependMessage(data, atTop = true) {
    if (!DOM.messages) return;
    const messages = DOM.messages;
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'none';

    const isMe = data.sender === currentUser;
    const isBot = data.isBot || data.sender === 'TunnelBot';
    const isCommand = data.isCommand;
    const msgEl = document.createElement('div');
    msgEl.id = 'msg-' + data.id;
    msgEl.dataset.msgId = data.id;

    const avatarHtml = data.avatar_url 
        ? `<img src="${data.avatar_url}" class="w-full h-full rounded-2xl object-cover">`
        : `<span class="text-xs font-black">${data.sender[0].toUpperCase()}</span>`;

    if (isBot) {
        msgEl.className = 'flex gap-4 flex-row group message-anim';
        msgEl.innerHTML = `
            <div class="avatar bot-avatar shadow-lg border border-cyan-500/30 flex items-center justify-center"><i class="fas fa-robot text-xs"></i></div>
            <div class="relative flex flex-col items-start max-w-[85%]">
                <div class="flex items-center gap-3 mb-1 px-1">
                    <span class="text-[10px] font-black uppercase text-cyan-400 tracking-widest">TunnelBot</span>
                    <span class="bot-badge">BOT</span>
                    <span class="text-[9px] font-bold opacity-30 text-white uppercase tracking-tighter">${data.time}</span>
                </div>
                <div class="p-5 rounded-[1.5rem] rounded-tl-none shadow-xl bot-bubble border border-cyan-500/10">
                    <p class="text-sm leading-relaxed font-medium">${parseMessageContent(data.text)}</p>
                </div>
            </div>`;
    } else if (isCommand) {
        msgEl.className = `flex gap-4 flex-row-reverse group message-anim`;
        msgEl.innerHTML = `
            <div class="avatar shadow-lg border border-white/5 overflow-hidden flex items-center justify-center" style="background:var(--accent)">${avatarHtml}</div>
            <div class="relative flex flex-col items-end max-w-[75%]">
                <div class="flex items-center gap-3 mb-1 px-1">
                    <span class="text-[9px] font-bold opacity-30 text-white uppercase tracking-tighter">${data.time}</span>
                </div>
                <div class="p-3 px-5 rounded-[1.5rem] rounded-tr-none shadow-xl command-bubble border border-white/[0.05]">
                    <p class="text-sm leading-relaxed font-mono font-medium"><span class="text-indigo-400">&gt;</span> ${parseMessageContent(data.text)}</p>
                </div>
            </div>`;
    } else {
        const userId = data.userId || data.user_id;
        const avatarColor = isMe ? 'var(--accent)' : '#1e293b';
        msgEl.className = `flex gap-4 ${isMe ? 'flex-row-reverse' : 'flex-row'} group message-anim`;
        msgEl.innerHTML = `
            <div class="avatar shadow-lg border border-white/5 overflow-hidden user-profile-trigger cursor-pointer flex items-center justify-center" data-user-id="${userId}" style="background:${avatarColor}">${avatarHtml}</div>
            <div class="relative flex flex-col ${isMe ? 'items-end' : 'items-start'} max-w-[75%]">
                <div class="flex items-center gap-3 mb-1 px-1">
                    ${!isMe ? `<span class="text-[10px] font-black uppercase text-indigo-400 tracking-widest cursor-pointer hover:underline user-profile-trigger" data-user-id="${userId}">${data.sender}</span>` : `<span class="text-[10px] font-black uppercase text-white/40 tracking-widest cursor-pointer hover:underline user-profile-trigger" data-user-id="${userId}">You</span>`}
                    <span class="text-[9px] font-bold opacity-30 text-white uppercase tracking-tighter">${data.time}</span>
                </div>
                <div class="p-4 rounded-[2rem] shadow-xl ${isMe ? 'rounded-tr-none text-white' : 'rounded-tl-none'} glass border border-white/[0.03] transition-all" 
                     style="${isMe ? 'background:var(--bubble-me); border-color:rgba(255,255,255,0.1)' : 'background:var(--bubble-them)'}">
                    <p class="text-sm leading-relaxed font-medium">${parseMessageContent(data.text)}</p>
                    ${data.ephemeral ? '<p class="text-[8px] italic opacity-50 mt-1">Ephemeral - Not saved to archive</p>' : ''}
                </div>
                <div class="reactions flex flex-wrap gap-1.5 mt-2">${renderReactions(data.id, data.reactions)}</div>
                <div class="status text-[9px] text-muted mt-2 flex items-center justify-between w-full px-1">
                    <div class="flex items-center gap-1.5">${isMe ? SVGS.sent : ''}</div>
                    <div class="hidden group-hover:flex gap-3 items-center ml-4 bg-black/40 backdrop-blur-md rounded-full px-3 py-1.5 border border-white/5">
                        <button onclick="addReaction(${data.id}, '👍')" class="hover:scale-125 transition-transform">👍</button>
                        <button onclick="addReaction(${data.id}, '❤️')" class="hover:scale-125 transition-transform">❤️</button>
                        <button onclick="addReaction(${data.id}, '🔥')" class="hover:scale-125 transition-transform">🔥</button>
                        ${isMe ? `<button onclick="deleteMessage(${data.id})" class="hover:text-red-500 transition-colors ml-1"><i class="fas fa-trash-alt text-[10px]"></i></button>` : ''}
                    </div>
                </div>
            </div>`;
    }
    
    if (atTop) {
        messages.prepend(msgEl);
    } else {
        messages.appendChild(msgEl);
    }

    if (!isBot && !isCommand) {
        observeMessage(msgEl);
        updateStatusFromData(msgEl, data);
        if (!isMe && !atTop) {
            socket.emit('message delivered', data.id);
        }
    }
    updateMessageCount();
}


function updateStatusFromData(el, data) {
    const statusEl = el.querySelector('.status div:first-child');
    if (data.sender === currentUser && statusEl) {
        if (data.read_at) {
            statusEl.innerHTML = SVGS.read;
        } else if (data.delivered_at) {
            statusEl.innerHTML = SVGS.delivered;
        } else {
            statusEl.innerHTML = SVGS.sent;
        }
    }
}

const intersectionObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
        if (entry.isIntersecting && !entry.target.dataset.read) {
            entry.target.dataset.read = 'true';
            const msgId = entry.target.dataset.msgId;
            socket.emit('message read', msgId);
        }
    });
}, { root: document.getElementById('messages'), threshold: 1.0 });

function observeMessage(el) {
    const inner = el.querySelector('.relative');
    if (inner) {
        intersectionObserver.observe(inner);
    }
}

function scrollToBottom() {
    const messages = document.getElementById('messages');
    if (messages) {
        messages.scrollTo({
            top: messages.scrollHeight,
            behavior: 'smooth'
        });
    }
}

// --- MONITORING STATS ---
async function fetchStats() {
    try {
        // Stats can also be fetched via HTTP for initial load or manual refresh
        const res = await fetch('/stats');
        const data = await res.json();
        updateStatsUI(data);
    } catch (e) {}
}

function updateStatsUI(stats) {
    if (document.getElementById('stat-uptime')) {
        document.getElementById('stat-uptime').innerText = stats.uptime + 's';
        document.getElementById('stat-memory').innerText = stats.memory + 'MB';
        document.getElementById('stat-conns').innerText = stats.connections;
        
        // New metrics
        if (document.getElementById('stat-nodes')) document.getElementById('stat-nodes').innerText = stats.cpu + '%';
        if (document.getElementById('mon-db-status')) document.getElementById('mon-db-status').innerText = stats.dbStatus;
        if (document.getElementById('mon-redis-status')) document.getElementById('mon-redis-status').innerText = stats.redisStatus;
        
        const memBar = document.getElementById('mem-bar');
        const cpuBar = document.getElementById('cpu-bar');
        const connBar = document.getElementById('conn-bar');

        if (memBar) {
            const pct = Math.min(100, (parseFloat(stats.memory) / 1000) * 100);
            memBar.style.width = pct + '%';
        }
        if (cpuBar) {
            cpuBar.style.width = stats.cpu + '%';
        }
        if (connBar) {
            const connPct = Math.min(100, (stats.connections / 10) * 100); // 10 is the bar max for visual
            connBar.style.width = connPct + '%';
        }

        const heart = document.getElementById('heartbeat-dot');
        if (heart) {
            heart.style.transform = 'scale(1.4)';
            setTimeout(() => heart.style.transform = 'scale(1)', 200);
        }

        // Update Frequency Chart
        if (msgFrequencyChart) {
            frequencyData.shift();
            frequencyData.push(stats.msgFreq || 0);
            frequencyLabels.shift();
            frequencyLabels.push(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
            msgFrequencyChart.update('none'); // Update without animation for performance
        }
    }
}

// --- SOCKET EVENT HANDLERS ---
socket.on('group:userJoined', (data) => {
    toast(`${data.username} joined #${data.groupName}`);
});

socket.on('group:deleted', (data) => {
    if (currentRoom === data.name) {
        toast(`Channel #${data.name} was deleted by admin`);
        joinRoom('general', allGroups.find(g => g.name === 'general')?.id || null);
    }
    fetchGroups();
});

socket.on('chat message', (data) => {
    if (data.room !== currentRoom) return;
    prependMessage(data, false);
    scrollToBottom();
});

    // 📣 NOTIFICATION SYSTEM
    if (!isMe && !isCommand) {
        showNotification(data);
        
        // Browser Push Notification (if tab is hidden)
        if (window.Notification && Notification.permission === 'granted' && document.hidden) {
            new Notification(`${data.sender}`, {
                body: data.text,
                icon: 'https://cdn-icons-png.flaticon.com/512/825/825590.png'
            });
        }
    }
});

socket.on('system-stats', (stats) => updateStatsUI(stats));

socket.on('typing', (data) => { 
    if (data.user !== currentUser && data.room === currentRoom) {
        document.getElementById('typing-indicator').style.opacity = data.isTyping ? '1' : '0';
    }
});

socket.on('messageDeleted', (msgId) => {
    const el = document.getElementById('msg-' + msgId);
    if (el) {
        // Apply a "Quantum" fade-out effect before removing
        el.style.opacity = '0';
        el.style.transform = 'scale(0.9)';
        el.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
        
        setTimeout(() => {
            el.remove();
            updateMessageCount();
        }, 300);
    }
});

socket.on('message delivered', (msgId) => {
    const el = document.querySelector(`[data-msg-id="${msgId}"] .status`);
    if (el && !el.innerHTML.includes('receipt-read')) el.innerHTML = SVGS.delivered;
});

socket.on('message read', (msgId) => {
    const s = document.querySelector(`[data-msg-id="${msgId}"] .status div:first-child`);
    if (s) s.innerHTML = SVGS.read;
});

socket.on('reaction', (data) => {
    const el = document.querySelector(`#msg-${data.messageId} .reactions`);
    if (el) {
        const groups = data.reactions || [];
        el.innerHTML = renderReactions(data.messageId, groups);
    }
});

socket.on('messageEdited', (data) => {
    const msgEl = document.getElementById('msg-' + data.msgId);
    if (msgEl) {
        const textEl = msgEl.querySelector('.glass p');
        if (textEl) textEl.innerHTML = parseMessageContent(data.newText);
        
        const statusDiv = msgEl.querySelector('.status div:first-child');
        if (statusDiv && !statusDiv.innerHTML.includes('(edited)')) {
            statusDiv.innerHTML += ` <span class="text-[8px] opacity-40 ml-1 italic">(edited)</span>`;
        }
        toast('Message updated');
    }
});

socket.on('messagePinned', (data) => {
    const msgEl = document.getElementById('msg-' + data.id);
    if (msgEl) {
        if (!msgEl.querySelector('.fa-thumbtack')) {
            const pinIcon = document.createElement('div');
            pinIcon.className = 'absolute -top-2 -right-2 w-5 h-5 bg-amber-500/20 text-amber-400 rounded-full flex items-center justify-center border border-amber-500/30 shadow-lg';
            pinIcon.innerHTML = `<i class="fas fa-thumbtack text-[8px]"></i>`;
            msgEl.querySelector('.relative').appendChild(pinIcon);
        }
    }
    socket.emit('fetchPinnedMessages', currentRoom);
    toast('Message pinned');
});

socket.on('messageUnpinned', (msgId) => {
    const msgEl = document.getElementById('msg-' + msgId);
    if (msgEl) {
        const pinIcon = msgEl.querySelector('.absolute.-top-2.-right-2');
        if (pinIcon) pinIcon.remove();
    }
    socket.emit('fetchPinnedMessages', currentRoom);
    toast('Message unpinned');
});

socket.on('pinnedMessages', (messages) => {
    renderPinnedMessages(messages);
});

socket.on('user:statusUpdate', (data) => {
    const user = allUsers.find(u => u.id === data.userId);
    if (user) {
        user.status_text = data.text;
        user.status_emoji = data.emoji;
        renderUsers();
    }
});

socket.on('addedToGroup', (data) => {
    showNotification({ 
        sender: "System Intelligence", 
        text: `You have been granted access to #${data.groupName} by ${data.inviter}`,
        isBot: true 
    });
    fetchGroups(); // Refresh group list to show new channel
});

socket.on('clear chat', () => {
    document.getElementById('messages').innerHTML = '';
    updateMessageCount();
});

socket.on('online:list', (ids) => {
    onlineUserIds = new Set(ids);
    renderUsers();
});

socket.on('user:online', (data) => {
    onlineUserIds.add(data.userId);
    renderUsers();
    toast(`${data.username} is online`);
});

socket.on('user:offline', (data) => {
    onlineUserIds.delete(data.userId);
    renderUsers();
});

socket.on('connect_error', (err) => {
    toast(err.message);
    if (err.message.includes('Authentication')) {
        logout();
    }
});

socket.on('group:userJoined', (data) => {
    if (data.username !== currentUser) {
        toast(`${data.username} joined #${data.groupName}`);
    }
});

// --- EVENT LISTENERS ---
document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('auth-user').value;
    const password = document.getElementById('auth-pass').value;
    try {
        const res = await fetch('/' + authMode, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
            if (authMode === 'login') {
                authToken = data.token;
                authUser = data.user;
                localStorage.setItem('tunnel_auth_token', authToken);
                localStorage.setItem('tunnel_auth_user', JSON.stringify(authUser));
                
                updateAuthUI();
                connectSocket();
                closeAuthModal();
                toast('Welcome back, ' + authUser.username);
                fetchAndRenderUsers();
            } else {
                toast('Resource created. Please login.');
                toggleAuthMode();
            }
        } else {
            toast(data.error || 'Authentication failed');
        }
    } catch (err) { toast('Auth service unavailable'); }
});

document.getElementById('input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
});

document.getElementById('form-submit-btn').addEventListener('click', sendMessage);

document.getElementById('search').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const term = e.target.value.toLowerCase();
    
    // Real-time filtering of current view
    document.querySelectorAll('#messages .relative').forEach(msg => {
        const text = msg.innerText.toLowerCase();
        msg.style.display = text.includes(term) ? '' : 'none';
    });
    updateMessageCount();

    // Global background search
    searchDebounce = setTimeout(() => {
        if (term.length > 2) performGlobalSearch(term, false);
    }, 500);
});

document.getElementById('sidebar-search').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
        performGlobalSearch(e.target.value, true);
    }, 400);
});

// Close search overlay when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('#sidebar-search') && !e.target.closest('#search-results-overlay')) {
        document.getElementById('search-results-overlay').classList.add('hidden');
    }
});

document.getElementById('messages').addEventListener('scroll', () => {
    if (document.getElementById('messages').scrollTop < 100) {
        loadMessages();
    }
});

document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('search').focus();
    }
    if (e.key === 'Escape') {
        if (editingMsgId) cancelEdit();
        if (replyingTo) cancelReply();
    }
});

document.getElementById('clear-chat').addEventListener('click', () => {
    if (confirm('Clear all messages?')) {
        socket.emit('clear chat');
        document.getElementById('messages').innerHTML = '';
        updateMessageCount();
        toast('Chat cleared');
    }
});

// --- INITIALIZATION ---
const savedTheme = localStorage.getItem('chat-theme') || 'dark';
applyTheme(savedTheme);

// Load groups first, then auto-join
(async () => {
    initCharts();
    if (authToken && authUser) {
        connectSocket();
    } else {
        await fetchGroups();
    }
})();

fetchAndRenderUsers();
showView('home');
requestNotifyPermission();
initGoogleAuth();

