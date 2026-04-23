const socket = io({ autoConnect: false });
let onlineUserIds = new Set();
let allUsers = [];
let allGroups = [];
let currentRoom = 'general';
let currentGroupId = null;

const themes = {
    dark: { 
        '--bg-main': '#0a0f1e', '--panel': 'rgba(16, 24, 39, 0.7)', '--text-main': '#f1f5f9', 
        '--accent': '#6366f1', '--bubble-me': '#6366f1', '--bubble-them': 'rgba(30, 41, 59, 0.8)' 
    },
    light: { 
        '--bg-main': '#f8fafc', '--panel': 'rgba(255, 255, 255, 0.9)', '--text-main': '#0f172a', 
        '--accent': '#4f46e5', '--bubble-me': '#4f46e5', '--bubble-them': 'rgba(241, 245, 249, 1)' 
    },
    solar: { 
        '--bg-main': '#002b36', '--panel': 'rgba(7, 54, 66, 0.8)', '--text-main': '#839496', 
        '--accent': '#b58900', '--bubble-me': '#b58900', '--bubble-them': 'rgba(7, 54, 66, 1)' 
    }
};

const SVGS = {
    sent: `<svg class="receipt-icon receipt-sent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    delivered: `<svg class="receipt-icon receipt-delivered" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 6 7 17 2 12"></polyline><polyline points="22 6 12.5 15.5"></polyline></svg>`,
    read: `<svg class="receipt-icon receipt-read" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 6 7 17 2 12"></polyline><polyline points="22 6 12.5 15.5"></polyline></svg>`
};

function applyTheme(name) {
    const root = document.documentElement;
    const vars = themes[name];
    if (vars) {
        Object.entries(vars).forEach(([key, val]) => root.style.setProperty(key, val));
        localStorage.setItem('chat-theme', name);
        toast(`Theme: ${name.toUpperCase()}`);
    }
}

let currentUser = null;
let authUser = JSON.parse(localStorage.getItem('tunnel_auth_user') || 'null');
let authToken = localStorage.getItem('tunnel_auth_token') || null;
let typingTimeout;
let monitoringInterval;
let authMode = 'login'; 

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
        document.getElementById('auth-nav').classList.remove('hidden');
        document.getElementById('login-btn').classList.add('hidden');
        document.getElementById('nav-username').innerText = authUser.username;
        document.getElementById('user-avatar-mini').innerText = authUser.username[0].toUpperCase();
        currentUser = authUser.username;
    } else {
        document.getElementById('auth-nav').classList.add('hidden');
        document.getElementById('login-btn').classList.remove('hidden');
        currentUser = null;
    }
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

// --- CORE CHAT LOGIC ---
function sendMessage() {
    const inputDom = document.getElementById('input');
    if (inputDom.value) {
        const payload = { 
            user: currentUser || 'Guest', 
            userId: authUser ? authUser.id : null,
            text: inputDom.value, 
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            room: currentRoom,
            groupId: currentGroupId
        };
        
        socket.emit('chat message', payload);
        inputDom.value = '';
        socket.emit('typing', { user: currentUser, isTyping: false, room: currentRoom });
    }
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
    showView('home');
    
    const isDM = room.startsWith('dm_');
    const display = isDM ? '@' + room.split('_').slice(1).join(' & ') : room;
    document.getElementById('active-room-display').innerText = display;
    document.getElementById('chat-header-icon').innerText = isDM ? '@' : '#';
    
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
        <div class="sidebar-item group" data-room="${room}" onclick="joinRoom('${room}')">
            <div class="relative">
                <div class="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-[10px] font-black border border-white/5 group-hover:border-indigo-500/30 transition-all">${u.username[0].toUpperCase()}</div>
                ${isOnline ? '<div class="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 bg-emerald-500 rounded-full border-2 border-bg-deep shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>' : ''}
            </div>
            <span class="truncate text-xs font-bold ${isOnline ? 'text-white/80' : 'text-white/30'}">${u.username}</span>
            ${isOnline ? '<span class="ml-auto w-1 h-1 rounded-full bg-indigo-500/50"></span>' : ''}
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
            const container = document.getElementById('messages');
            container.scrollTop = container.scrollHeight;
        }
        offset += data.length;
    } catch (e) { console.error('Error loading messages', e); }
    finally { fetching = false; }
}

function prependMessage(data, atTop = true) {
    const messages = document.getElementById('messages');
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'none';

    const isMe = data.sender === currentUser;
    const isBot = data.isBot || data.sender === 'TunnelBot';
    const isCommand = data.isCommand;
    const msgEl = document.createElement('div');
    msgEl.id = 'msg-' + data.id;
    msgEl.dataset.msgId = data.id;

    if (isBot) {
        msgEl.className = 'flex gap-4 flex-row group message-anim';
        msgEl.innerHTML = `
            <div class="avatar bot-avatar shadow-lg border border-cyan-500/30"><i class="fas fa-robot"></i></div>
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
            <div class="avatar shadow-lg border border-white/5" style="background:var(--accent)">${data.sender[0].toUpperCase()}</div>
            <div class="relative flex flex-col items-end max-w-[75%]">
                <div class="flex items-center gap-3 mb-1 px-1">
                    <span class="text-[9px] font-bold opacity-30 text-white uppercase tracking-tighter">${data.time}</span>
                </div>
                <div class="p-3 px-5 rounded-[1.5rem] rounded-tr-none shadow-xl command-bubble border border-white/[0.05]">
                    <p class="text-sm leading-relaxed font-mono font-medium"><span class="text-indigo-400">&gt;</span> ${parseMessageContent(data.text)}</p>
                </div>
            </div>`;
    } else {
        const avatarColor = isMe ? 'var(--accent)' : '#1e293b';
        msgEl.className = `flex gap-4 ${isMe ? 'flex-row-reverse' : 'flex-row'} group message-anim`;
        msgEl.innerHTML = `
            <div class="avatar shadow-lg border border-white/5" style="background:${avatarColor}">${data.sender[0].toUpperCase()}</div>
            <div class="relative flex flex-col ${isMe ? 'items-end' : 'items-start'} max-w-[75%]">
                <div class="flex items-center gap-3 mb-1 px-1">
                    ${!isMe ? `<span class="text-[10px] font-black uppercase text-indigo-400 tracking-widest">${data.sender}</span>` : ''}
                    <span class="text-[9px] font-bold opacity-30 text-white uppercase tracking-tighter">${data.time}</span>
                </div>
                <div class="p-4 rounded-[1.5rem] shadow-xl ${isMe ? 'rounded-tr-none text-white' : 'rounded-tl-none'} glass border border-white/[0.03] transition-all" 
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
        if (document.getElementById('mon-db-status')) document.getElementById('mon-db-status').innerText = stats.dbStatus;
        if (document.getElementById('mon-redis-status')) document.getElementById('mon-redis-status').innerText = stats.redisStatus;
        
        const memBar = document.getElementById('mem-bar');
        if (memBar) {
            const pct = Math.min(100, (parseFloat(stats.memory) / 1000) * 100);
            memBar.style.width = pct + '%';
        }

        const heart = document.getElementById('heartbeat-dot');
        if (heart) {
            heart.style.transform = 'scale(1.4)';
            setTimeout(() => heart.style.transform = 'scale(1)', 200);
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
    const messages = document.getElementById('messages');
    const emptyState = document.getElementById('empty-state');
    if (emptyState) emptyState.style.display = 'none';

    const isMe = data.sender === currentUser;
    const isBot = data.isBot || data.sender === 'TunnelBot';
    const isCommand = data.isCommand;
    const msgEl = document.createElement('div');
    msgEl.id = 'msg-' + data.id;
    msgEl.dataset.msgId = data.id;

    if (isBot) {
        // Bot response with unique styling
        msgEl.className = 'flex gap-4 flex-row group message-anim';
        msgEl.innerHTML = `
            <div class="avatar bot-avatar shadow-lg border border-cyan-500/30"><i class="fas fa-robot"></i></div>
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
        // User's slash command (terminal style, right-aligned)
        msgEl.className = `flex gap-4 flex-row-reverse group message-anim`;
        msgEl.innerHTML = `
            <div class="avatar shadow-lg border border-white/5" style="background:var(--accent)">${data.sender[0].toUpperCase()}</div>
            <div class="relative flex flex-col items-end max-w-[75%]">
                <div class="flex items-center gap-3 mb-1 px-1">
                    <span class="text-[9px] font-bold opacity-30 text-white uppercase tracking-tighter">${data.time}</span>
                </div>
                <div class="p-3 px-5 rounded-[1.5rem] rounded-tr-none shadow-xl command-bubble border border-white/[0.05]">
                    <p class="text-sm leading-relaxed font-mono font-medium"><span class="text-indigo-400">&gt;</span> ${parseMessageContent(data.text)}</p>
                </div>
            </div>`;
    } else {
        // Regular user message
        const avatarColor = isMe ? 'var(--accent)' : '#1e293b';
        msgEl.className = `flex gap-4 ${isMe ? 'flex-row-reverse' : 'flex-row'} group message-anim`;
        msgEl.innerHTML = `
            <div class="avatar shadow-lg border border-white/5" style="background:${avatarColor}">${data.sender[0].toUpperCase()}</div>
            <div class="relative flex flex-col ${isMe ? 'items-end' : 'items-start'} max-w-[75%]">
                <div class="flex items-center gap-3 mb-1 px-1">
                    ${!isMe ? `<span class="text-[10px] font-black uppercase text-indigo-400 tracking-widest">${data.sender}</span>` : ''}
                    <span class="text-[9px] font-bold opacity-30 text-white uppercase tracking-tighter">${data.time}</span>
                </div>
                <div class="p-4 rounded-[1.5rem] shadow-xl ${isMe ? 'rounded-tr-none text-white' : 'rounded-tl-none'} glass border border-white/[0.03] transition-all" 
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

    messages.scrollTop = messages.scrollHeight;
    updateMessageCount();

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
        const existing = el.innerHTML;
        if (!existing.includes(data.emoji)) {
            el.innerHTML += `<div class="bg-slate-900/50 rounded-full px-2 py-0.5 border border-white/5 text-[10px] flex items-center gap-1"><span>${data.emoji}</span><span>1</span></div>`;
        } else {
            el.querySelectorAll('div').forEach(div => {
                if (div.innerText.includes(data.emoji)) {
                    const countSpan = div.querySelectorAll('span')[1];
                    countSpan.innerText = parseInt(countSpan.innerText) + 1;
                }
            });
        }
    }
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
                socket.auth = { token: authToken };
                socket.connect();
                updateAuthUI();
                closeAuthModal();
                toast('Welcome back, ' + authUser.username);
                fetchAndRenderUsers();
                await fetchGroups();
                const generalGroup = allGroups.find(g => g.name === 'general');
                joinRoom('general', generalGroup?.id || null);
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

document.getElementById('search').addEventListener('input', () => {
    const term = document.getElementById('search').value.toLowerCase();
    document.querySelectorAll('#messages .relative').forEach(msg => {
        const text = msg.innerText.toLowerCase();
        msg.style.display = text.includes(term) ? '' : 'none';
    });
    updateMessageCount();
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
    await fetchGroups();
    if (authToken && authUser) {
        updateAuthUI();
        socket.auth = { token: authToken };
        socket.connect();
        const generalGroup = allGroups.find(g => g.name === 'general');
        joinRoom('general', generalGroup?.id || null);
    }
})();

updateAuthUI();
fetchAndRenderUsers();
showView('home');
requestNotifyPermission();

