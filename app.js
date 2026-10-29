// ===== CONFIGURAÇÃO (cole os dados do seu projeto: Project Settings > API) =====
// A anon key é pública e pode ficar aqui. NUNCA cole a service_role key.
const SUPABASE_URL = 'https://tbtwgedkgnwalfgmkgxo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_FTk-GlxuznZ3sFdkunOC6Q_rO2zreEp';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ===== ESTADO =====
const state = {
    me: null,               // perfil de quem está logado
    profiles: new Map(),    // id -> perfil
    atividades: [],
    done: new Set(),        // ids das atividades que EU concluí
    messages: [],
    currentChannel: 'geral',
    activeSubTab: 'pendentes',
    signupMode: false,
    realtime: null
};

// ===== UTILITÁRIOS =====
const $ = (id) => document.getElementById(id);
const escapeHTML = (v) => { const d = document.createElement('div'); d.textContent = v ?? ''; return d.innerHTML; };
const isAdmin = () => state.me?.role === 'Admin';
const nameOf = (id) => state.profiles.get(id)?.name || 'Aluno removido';
const numberLabel = (n) => n || '--';

function formatDate(iso) {
    const [y, m, d] = (iso || '').split('-');
    return y && m && d ? `${d}/${m}/${y}` : iso;
}
function todayISO() {
    const n = new Date(), p = (x) => String(x).padStart(2, '0');
    return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}
function fail(error, fallback = 'Algo deu errado. Tente de novo.') {
    console.error(error);
    alert(error?.message ? `${fallback}\n(${error.message})` : fallback);
}
function loginMessage(text, ok = false) {
    const el = $('login-msg');
    el.textContent = text;
    el.classList.toggle('ok', ok);
    el.classList.toggle('hidden', !text);
}

// ===== ELEMENTOS =====
const loginModal = $('login-modal'), appContainer = $('app-container');
const navBtns = document.querySelectorAll('.nav-btn'), views = document.querySelectorAll('.view-section');
const channelItems = document.querySelectorAll('.channel-item'), subBtns = document.querySelectorAll('.sub-btn');
const chatMessages = $('chat-messages'), chatInput = $('chat-input'), atividadesList = $('atividades-list');
const taskModal = $('task-modal'), adminUserList = $('admin-user-list');

// ===== LOGIN / CADASTRO =====
function setSignupMode(on) {
    state.signupMode = on;
    document.querySelectorAll('.signup-only').forEach(el => el.classList.toggle('hidden', !on));
    $('nome-aluno').required = on;
    $('btn-login-submit').textContent = on ? 'Criar conta' : 'Entrar';
    $('btn-toggle-mode').textContent = on ? 'Já tenho conta. Entrar' : 'Primeiro acesso? Criar conta';
    $('senha').autocomplete = on ? 'new-password' : 'current-password';
    loginMessage('');
}
$('btn-toggle-mode').addEventListener('click', () => setSignupMode(!state.signupMode));

$('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('email').value.trim(), password = $('senha').value;
    const btn = $('btn-login-submit');
    btn.disabled = true; loginMessage('');

    try {
        if (state.signupMode) {
            const { data, error } = await db.auth.signUp({
                email, password,
                options: { data: { name: $('nome-aluno').value.trim(), number: $('numero-chamada').value.trim() } }
            });
            if (error) throw error;
            if (!data.session) {
                loginMessage('Conta criada! Confirme o e-mail que enviamos e depois entre.', true);
                setSignupMode(false);
                return;
            }
        } else {
            const { error } = await db.auth.signInWithPassword({ email, password });
            if (error) throw error;
        }
        await boot();
    } catch (err) {
        loginMessage(err.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : err.message);
    } finally {
        btn.disabled = false;
    }
});

$('btn-logout').addEventListener('click', logout);
async function logout() {
    await db.auth.signOut();
    location.reload();
}

// ===== INICIALIZAÇÃO =====
async function boot() {
    const { data: { user } } = await db.auth.getUser();
    if (!user) return;

    const { data: me, error } = await db.from('profiles').select('*').eq('id', user.id).single();
    if (error || !me) { fail(error, 'Não consegui carregar seu perfil.'); return; }
    if (me.banned) { alert('Você foi removido da sala. Fale com o professor.'); await logout(); return; }

    state.me = me;
    showApp();
    await Promise.all([loadProfiles(), loadAtividades(), loadMessages()]);
    subscribeRealtime();
}

function showApp() {
    const m = state.me, initial = m.name.charAt(0).toUpperCase();
    $('user-name-display').textContent = m.name;
    $('user-role-display').textContent = isAdmin() ? 'Criador / Admin' : (m.number ? `Aluno nº ${m.number}` : 'Aluno');
    $('user-avatar-tag').textContent = initial;
    $('profile-name').textContent = m.name;
    $('profile-number').textContent = `Número da chamada: ${numberLabel(m.number)}`;
    $('profile-role-badge').textContent = m.role;
    $('profile-big-avatar').textContent = initial;
    document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
    loginModal.classList.add('hidden');
    appContainer.classList.remove('hidden');
}

(async () => {
    setSignupMode(false);
    const { data: { session } } = await db.auth.getSession();
    if (session) boot();
})();

// ===== CARREGAR DADOS =====
async function loadProfiles() {
    const { data, error } = await db.from('profiles').select('*').order('name');
    if (error) return fail(error);
    state.profiles = new Map(data.map(p => [p.id, p]));
    const mine = state.profiles.get(state.me.id);
    if (mine?.banned) { alert('Você foi removido da sala.'); return logout(); }
    renderAdminPanel(); renderAtividades(); renderMessages();
}

async function loadAtividades() {
    const [{ data: tasks, error: e1 }, { data: dones, error: e2 }] = await Promise.all([
        db.from('atividades').select('*').order('due_date'),
        db.from('conclusoes').select('atividade_id').eq('user_id', state.me.id)
    ]);
    if (e1 || e2) return fail(e1 || e2);
    state.atividades = tasks;
    state.done = new Set(dones.map(d => d.atividade_id));
    renderAtividades();
}

async function loadMessages() {
    const { data, error } = await db.from('mensagens').select('*')
        .eq('canal', state.currentChannel).order('created_at', { ascending: false }).limit(100);
    if (error) return fail(error);
    state.messages = data.reverse();
    renderMessages();
}

function subscribeRealtime() {
    if (state.realtime) return;
    state.realtime = db.channel('classhub')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'mensagens' }, loadMessages)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'atividades' }, loadAtividades)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, loadProfiles)
        .subscribe();
}

// ===== MENU RETRÁTIL (CELULAR) =====
const closeMenu = () => appContainer.classList.remove('sidebar-open');
$('btn-menu').addEventListener('click', () => appContainer.classList.toggle('sidebar-open'));
$('sidebar-backdrop').addEventListener('click', closeMenu);

// ===== NAVEGAÇÃO =====
navBtns.forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.view === 'admin' && !isAdmin()) return;
    navBtns.forEach(b => b.classList.remove('active'));
    views.forEach(v => v.classList.add('hidden'));
    btn.classList.add('active');
    $(`view-${btn.dataset.view}`)?.classList.remove('hidden');
    closeMenu();
}));

subBtns.forEach(btn => btn.addEventListener('click', () => {
    subBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeSubTab = btn.dataset.subview;
    renderAtividades();
}));

// ===== ATIVIDADES =====
$('btn-open-task-modal').addEventListener('click', () => {
    $('task-modal-title').textContent = 'Nova Atividade';
    $('task-edit-id').value = '';
    $('form-atividade').reset();
    taskModal.classList.remove('hidden');
    $('task-title').focus();
});
const closeTaskModal = () => taskModal.classList.add('hidden');
$('btn-cancel-task').addEventListener('click', closeTaskModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTaskModal(); });

$('form-atividade').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('task-edit-id').value;
    const fields = {
        title: $('task-title').value.trim(),
        subject: $('task-subject').value.trim(),
        due_date: $('task-date').value
    };
    const { error } = id
        ? await db.from('atividades').update(fields).eq('id', id)
        : await db.from('atividades').insert(fields);
    if (error) return fail(error, 'Não consegui salvar a atividade.');
    closeTaskModal();
    loadAtividades();
});

function renderAtividades() {
    if (!state.me) return;
    const today = todayISO();
    const pendentes = state.atividades.filter(t => !state.done.has(t.id));
    const concluidas = state.atividades.filter(t => state.done.has(t.id));

    $('count-pendentes').textContent = pendentes.length;
    $('count-concluidas').textContent = concluidas.length;
    $('profile-tasks-count').textContent = `${concluidas.length} ${concluidas.length === 1 ? 'Atividade' : 'Atividades'}`;

    const isPend = state.activeSubTab === 'pendentes';
    const list = isPend ? pendentes : concluidas;
    if (!list.length) {
        atividadesList.innerHTML = '<p class="empty-hint" style="grid-column: 1/-1;">Nenhuma atividade nesta aba.</p>';
        return;
    }

    atividadesList.innerHTML = list.map(t => {
        const canManage = t.author_id === state.me.id || isAdmin();
        const late = isPend && t.due_date < today;
        return `
            <div class="atividade-card">
                <div>
                    <span class="atividade-tag">${escapeHTML(t.subject)}</span>${late ? '<span class="atividade-tag badge-late">Atrasada</span>' : ''}
                    <h3>${escapeHTML(t.title)}</h3>
                    <p>Entrega até: ${escapeHTML(formatDate(t.due_date))}</p>
                    <small class="author-tag">Postado por: <strong>${escapeHTML(nameOf(t.author_id))}</strong></small>
                </div>
                <div class="card-footer">
                    <button class="${isPend ? 'btn-primary' : 'btn-secondary'}" data-action="toggle" data-id="${t.id}">
                        ${isPend ? '✅ Marcar como Concluída' : '↩️ Marcar como Pendente'}
                    </button>
                    ${canManage ? `
                        <div class="card-actions">
                            <button class="btn-card-action" data-action="edit" data-id="${t.id}">✏️ Editar</button>
                            <button class="btn-card-action danger" data-action="delete" data-id="${t.id}">🗑️ Excluir</button>
                        </div>` : ''}
                </div>
            </div>`;
    }).join('');
}

atividadesList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const task = state.atividades.find(t => t.id === btn.dataset.id);
    if (!task) return;

    if (btn.dataset.action === 'toggle') {
        const { error } = state.done.has(task.id)
            ? await db.from('conclusoes').delete().eq('atividade_id', task.id).eq('user_id', state.me.id)
            : await db.from('conclusoes').insert({ atividade_id: task.id });
        if (error) return fail(error);
        loadAtividades();
    } else if (btn.dataset.action === 'edit') {
        $('task-modal-title').textContent = 'Editar Atividade';
        $('task-edit-id').value = task.id;
        $('task-title').value = task.title;
        $('task-subject').value = task.subject;
        $('task-date').value = task.due_date;
        taskModal.classList.remove('hidden');
    } else if (btn.dataset.action === 'delete' && confirm('Deseja remover esta atividade?')) {
        const { error } = await db.from('atividades').delete().eq('id', task.id);
        if (error) return fail(error);
        loadAtividades();
    }
});

// ===== CHAT =====
channelItems.forEach(item => item.addEventListener('click', () => {
    channelItems.forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    state.currentChannel = item.dataset.channel;
    $('current-channel-title').textContent = item.textContent;
    chatInput.placeholder = `Enviar mensagem em ${item.textContent}...`;
    loadMessages();
    closeMenu();
}));

$('form-chat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    const { error } = await db.from('mensagens').insert({ canal: state.currentChannel, text });
    if (error) { chatInput.value = text; return fail(error, 'Não consegui enviar a mensagem.'); }
    loadMessages();
});

function renderMessages() {
    chatMessages.innerHTML = state.messages.length ? state.messages.map(m => {
        const name = nameOf(m.author_id);
        const time = new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        return `
            <div class="message-card">
                <div class="msg-avatar">${escapeHTML(name.charAt(0).toUpperCase())}</div>
                <div class="msg-body">
                    <div class="msg-header"><span class="msg-author">${escapeHTML(name)}</span><span class="msg-time">${time}</span></div>
                    <p>${escapeHTML(m.text)}</p>
                </div>
            </div>`;
    }).join('') : '<p class="empty-hint">Ainda não há mensagens neste canal. Mande a primeira!</p>';
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ===== PAINEL ADMIN =====
function renderAdminPanel() {
    if (!isAdmin()) return;
    adminUserList.innerHTML = [...state.profiles.values()].map(u => `
        <li class="admin-item">
            <span>${escapeHTML(u.name)} (Nº ${escapeHTML(numberLabel(u.number))}) - <strong>${escapeHTML(u.role)}</strong>
                ${u.banned ? '<span class="badge-banned">expulso</span>' : ''}</span>
            ${u.role !== 'Admin' && !u.banned ? `<button class="btn-delete" data-user="${u.id}">Expulsar</button>` : ''}
        </li>`).join('');
}

adminUserList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-user]');
    if (!btn || !isAdmin()) return;
    const u = state.profiles.get(btn.dataset.user);
    if (!u || !confirm(`Expulsar ${u.name}?`)) return;
    const { error } = await db.rpc('expulsar', { alvo: u.id });
    if (error) return fail(error);
    loadProfiles();
});