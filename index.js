import {
    characters,
    deleteCharacter,
    printCharactersDebounced,
    saveSettingsDebounced,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import {
    addTagsToEntity,
    getTagsList,
    printTagFilters,
    tag_filter_type,
    tag_map,
    tags,
    TAG_FOLDER_DEFAULT_TYPE,
} from '../../../tags.js';
import { DEFAULT_FILTER_STATE } from '../../../filters.js';
import { download, equalsIgnoreCaseAndAccents, uuidv4 } from '../../../utils.js';

const EXTENSION_KEY = 'bulkTagStudio';
const selectedAvatars = new Set();
let recentTrackerBound = false;
const state = {
    tab: 'characters',
    sort: 'recent',
    currentFolderId: null,
    onlyCurrentFolder: false,
    editingFolderId: null,
};

const selectors = {
    root: '#btm-root',
    search: '#btm-search',
    list: '#btm-character-list',
    input: '#btm-tags-input',
    preview: '#btm-preview',
    count: '#btm-count',
    status: '#btm-status',
};

function settings() {
    extension_settings[EXTENSION_KEY] ??= {};
    const value = extension_settings[EXTENSION_KEY];
    value.schemaVersion = 2;
    value.folderParents ??= {};
    value.folderOrder ??= [];
    value.recentOpened ??= {};
    return value;
}

function persist() {
    cleanupFolderMetadata();
    saveSettingsDebounced();
}

function cleanupFolderMetadata() {
    const value = settings();
    const ids = new Set(tags.map(tag => tag.id));
    for (const [id, parentId] of Object.entries(value.folderParents)) {
        if (!ids.has(id) || (parentId && !ids.has(parentId)) || id === parentId) {
            delete value.folderParents[id];
        }
    }
    value.folderOrder = value.folderOrder.filter((id, index, all) => ids.has(id) && all.indexOf(id) === index);
    for (const tag of tags) {
        if (!value.folderOrder.includes(tag.id)) value.folderOrder.push(tag.id);
    }
}

function parseTagNames(value) {
    const names = value.split(/[\s,，、]+/u).map(name => name.trim()).filter(Boolean);
    return names.filter((name, index) => names.findIndex(other => equalsIgnoreCaseAndAccents(other, name)) === index);
}

function availableCharacters() {
    return characters.filter(character => character?.avatar && character?.name);
}

function tagById(id) {
    return tags.find(tag => tag.id === id);
}

function parentOf(id) {
    return settings().folderParents[id] || null;
}

function childrenOf(parentId) {
    cleanupFolderMetadata();
    const order = settings().folderOrder;
    return tags
        .filter(tag => parentOf(tag.id) === parentId)
        .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

function descendantIds(folderId) {
    const result = [];
    const visited = new Set([folderId]);
    const queue = [folderId];
    while (queue.length) {
        const current = queue.shift();
        for (const child of childrenOf(current)) {
            if (visited.has(child.id)) continue;
            visited.add(child.id);
            result.push(child.id);
            queue.push(child.id);
        }
    }
    return result;
}

function characterTags(character) {
    return getTagsList(character.avatar);
}

function charactersForFolder(folderId, includeDescendants = true) {
    const folderIds = new Set([folderId]);
    if (includeDescendants) descendantIds(folderId).forEach(id => folderIds.add(id));
    return availableCharacters().filter(character => (tag_map[character.avatar] || []).some(id => folderIds.has(id)));
}

function normalizedName(character) {
    return String(character?.name || '')
        .normalize('NFKC')
        .replace(/[\p{P}\p{S}]/gu, '')
        .trim();
}

function localeNameCompare(a, b) {
    const first = normalizedName(a);
    const second = normalizedName(b);
    const firstStartsLatin = /^[A-Za-z]/u.test(first);
    const secondStartsLatin = /^[A-Za-z]/u.test(second);
    if (firstStartsLatin !== secondStartsLatin) return firstStartsLatin ? -1 : 1;
    return first.localeCompare(second, 'zh-CN-u-co-pinyin', { sensitivity: 'base', numeric: true });
}

function timestampValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function recentValue(character) {
    return Number(settings().recentOpened[character.avatar])
        || timestampValue(character.date_last_chat)
        || timestampValue(character.create_date);
}

function bindRecentTracker() {
    if (recentTrackerBound) return;
    recentTrackerBound = true;
    document.addEventListener('click', event => {
        const card = event.target.closest?.('.character_select[data-chid]');
        if (!card) return;
        const character = characters[Number(card.dataset.chid)];
        if (!character?.avatar) return;
        settings().recentOpened[character.avatar] = Date.now();
        saveSettingsDebounced();
    }, true);
}

function sortedCharacters(items) {
    const copy = [...items];
    const sort = document.querySelector('#btm-sort')?.value || state.sort;
    if (sort === 'az') return copy.sort(localeNameCompare);
    if (sort === 'za') return copy.sort((a, b) => localeNameCompare(b, a));
    if (sort === 'newest') {
        return copy.sort((a, b) => timestampValue(b.create_date) - timestampValue(a.create_date) || localeNameCompare(a, b));
    }
    return copy.sort((a, b) => recentValue(b) - recentValue(a) || localeNameCompare(a, b));
}

function visibleCharacters() {
    const input = document.querySelector(selectors.search);
    const query = input?.value.trim().toLocaleLowerCase() || '';
    const filtered = availableCharacters().filter(character => {
        if (!query) return true;
        return character.name.toLocaleLowerCase().includes(query)
            || characterTags(character).some(tag => tag.name.toLocaleLowerCase().includes(query));
    });
    return sortedCharacters(filtered);
}

function thumbnailUrl(avatar) {
    try {
        return globalThis.SillyTavern?.getContext?.().getThumbnailUrl('avatar', avatar)
            || `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
    } catch {
        return `/thumbnail?type=avatar&file=${encodeURIComponent(avatar)}`;
    }
}

function createCharacterRow(character, { selectable = true } = {}) {
    const row = document.createElement(selectable ? 'label' : 'div');
    row.className = 'btm-character';
    if (selectable) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedAvatars.has(character.avatar);
        checkbox.setAttribute('aria-label', `选择 ${character.name}`);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedAvatars.add(character.avatar);
            else selectedAvatars.delete(character.avatar);
            row.classList.toggle('btm-selected', checkbox.checked);
            updateCount();
        });
        row.classList.toggle('btm-selected', checkbox.checked);
        row.append(checkbox);
    }

    const image = document.createElement('img');
    image.className = 'btm-avatar';
    image.src = thumbnailUrl(character.avatar);
    image.alt = '';
    image.loading = 'lazy';

    const details = document.createElement('span');
    details.className = 'btm-character-details';
    const name = document.createElement('strong');
    name.textContent = character.name;
    const assigned = document.createElement('span');
    assigned.className = 'btm-card-tags';
    const ownTags = characterTags(character);
    if (ownTags.length) {
        for (const tag of ownTags) {
            const chip = document.createElement('small');
            chip.textContent = tag.name;
            assigned.append(chip);
        }
    } else {
        const empty = document.createElement('small');
        empty.className = 'btm-muted-chip';
        empty.textContent = '暂无标签';
        assigned.append(empty);
    }
    details.append(name, assigned);
    row.append(image, details);
    return row;
}

function updateCount() {
    const count = document.querySelector(selectors.count);
    if (count) count.textContent = `已选 ${selectedAvatars.size} 张 · 共 ${availableCharacters().length} 张`;
}

function renderCharacterList() {
    const list = document.querySelector(selectors.list);
    if (!list) return;
    const fragment = document.createDocumentFragment();
    const visible = visibleCharacters();
    for (const character of visible) fragment.append(createCharacterRow(character));
    if (!visible.length) fragment.append(emptyMessage('没有找到角色卡'));
    list.replaceChildren(fragment);
    updateCount();
}

function emptyMessage(text) {
    const empty = document.createElement('p');
    empty.className = 'btm-empty';
    empty.textContent = text;
    return empty;
}

function renderPreview() {
    const input = document.querySelector(selectors.input);
    const preview = document.querySelector(selectors.preview);
    if (!input || !preview) return;
    preview.replaceChildren();
    for (const name of parseTagNames(input.value)) {
        const chip = document.createElement('span');
        chip.className = 'btm-tag-chip';
        chip.textContent = name;
        preview.append(chip);
    }
}

function setStatus(message, isError = false) {
    const status = document.querySelector(selectors.status);
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('btm-error', isError);
}

function makeTag(name) {
    const existing = tags.find(tag => equalsIgnoreCaseAndAccents(tag.name, name));
    if (existing) return existing;
    const tag = {
        id: uuidv4(),
        name,
        folder_type: TAG_FOLDER_DEFAULT_TYPE,
        filter_state: DEFAULT_FILTER_STATE,
        sort_order: tags.reduce((max, current) => Math.max(max, Number(current.sort_order) || 0), 0) + 1,
        is_hidden_on_character_card: false,
        color: '',
        color2: '',
        create_date: Date.now(),
    };
    tags.push(tag);
    settings().folderOrder.push(tag.id);
    return tag;
}

function refreshNativeTags() {
    printTagFilters(tag_filter_type.character);
    printTagFilters(tag_filter_type.group_candidates_list);
    printTagFilters(tag_filter_type.group_members_list);
    printCharactersDebounced();
    saveSettingsDebounced();
}

function applyTags() {
    const names = parseTagNames(document.querySelector(selectors.input).value);
    if (!selectedAvatars.size) return setStatus('请先勾选角色卡。', true);
    if (!names.length) return setStatus('请输入至少一个标签。', true);
    if (names.some(name => name.length > 25)) return setStatus('每个标签最多 25 个字符。', true);

    const currentAvatars = new Set(availableCharacters().map(character => character.avatar));
    const targets = [...selectedAvatars].filter(avatar => currentAvatars.has(avatar));
    if (!targets.length) return setStatus('所选角色卡已不在列表中，请重新选择。', true);

    try {
        const tagObjects = names.map(makeTag);
        const changed = addTagsToEntity(tagObjects, targets);
        renderCharacterList();
        setStatus(changed ? `已为 ${targets.length} 张角色卡添加：${names.join('、')}` : '这些角色卡已经有了所输入的标签。');
    } catch (error) {
        console.error('[角色卡整理器] 添加失败', error);
        setStatus('添加失败，请查看浏览器控制台。', true);
    }
}

async function deleteSelectedCharacters() {
    const existing = new Set(availableCharacters().map(character => character.avatar));
    const targets = [...selectedAvatars].filter(avatar => existing.has(avatar));
    if (!targets.length) return setStatus('请先勾选要删除的角色卡。', true);
    const deleteChats = document.querySelector('#btm-delete-chats').checked;
    const chatText = deleteChats ? '并同时删除这些角色的聊天记录' : '但保留聊天记录';
    const confirmed = window.confirm(`即将永久删除 ${targets.length} 张角色卡，${chatText}。\n\n此操作不能撤回，确定继续吗？`);
    if (!confirmed) return;

    setStatus('正在删除，请不要关闭页面……');
    try {
        await deleteCharacter(targets, { deleteChats });
        targets.forEach(avatar => selectedAvatars.delete(avatar));
        renderCharacterList();
        setStatus(`已删除 ${targets.length} 张角色卡。`);
    } catch (error) {
        console.error('[角色卡整理器] 删除失败', error);
        setStatus('删除未完成，请查看酒馆提示或浏览器控制台。', true);
    }
}

function folderCount(folderId) {
    return charactersForFolder(folderId, true).length;
}

function renderBreadcrumbs(container) {
    const trail = [];
    let id = state.currentFolderId;
    const visited = new Set();
    while (id && !visited.has(id)) {
        visited.add(id);
        const tag = tagById(id);
        if (!tag) break;
        trail.unshift(tag);
        id = parentOf(id);
    }
    if (state.currentFolderId) {
        const root = document.createElement('button');
        root.type = 'button';
        root.textContent = '‹';
        root.title = '返回最外层';
        root.setAttribute('aria-label', '返回最外层');
        root.addEventListener('click', () => {
            state.currentFolderId = null;
            state.editingFolderId = null;
            renderFoldersPage();
        });
        container.append(root);
    }
    trail.forEach((tag, index) => {
        if (index > 0) {
            const sep = document.createElement('span');
            sep.textContent = '›';
            container.append(sep);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = tag.name;
        button.addEventListener('click', () => {
            state.currentFolderId = tag.id;
            state.editingFolderId = null;
            renderFoldersPage();
        });
        container.append(button);
    });
}

function createFolderRow(tag) {
    const row = document.createElement('div');
    row.className = 'btm-folder-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btm-folder-open';
    open.innerHTML = `<span class="btm-folder-icon">📁</span><span><strong></strong><small></small></span>`;
    open.querySelector('strong').textContent = tag.name;
    open.querySelector('small').textContent = `${folderCount(tag.id)} 张角色卡 · ${childrenOf(tag.id).length} 个子文件夹`;
    open.addEventListener('click', () => {
        state.currentFolderId = tag.id;
        state.editingFolderId = null;
        renderFoldersPage();
    });
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btm-folder-edit';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => {
        state.editingFolderId = state.editingFolderId === tag.id ? null : tag.id;
        renderFoldersPage();
    });
    row.append(open, edit);
    return row;
}

function renderFolderEditor(container, tag) {
    const editor = document.createElement('section');
    editor.className = 'btm-folder-editor';
    const invalidParents = new Set([tag.id, ...descendantIds(tag.id)]);
    const choices = tags.filter(item => !invalidParents.has(item.id));
    editor.innerHTML = `
        <h3>编辑“${escapeHtml(tag.name)}”</h3>
        <label>名称<input id="btm-edit-name" maxlength="25"></label>
        <label>上级文件夹<select id="btm-edit-parent"><option value="">最外层</option></select></label>
        <div class="btm-editor-actions">
            <button type="button" data-action="save">保存修改</button>
            <button type="button" data-action="up">上移</button>
            <button type="button" data-action="down">下移</button>
            <button type="button" data-action="delete" class="btm-danger">删除文件夹</button>
        </div>`;
    const nameInput = editor.querySelector('#btm-edit-name');
    nameInput.value = tag.name;
    const select = editor.querySelector('#btm-edit-parent');
    for (const choice of choices) {
        const option = document.createElement('option');
        option.value = choice.id;
        option.textContent = folderPath(choice.id);
        select.append(option);
    }
    select.value = parentOf(tag.id) || '';
    editor.querySelector('[data-action="save"]').addEventListener('click', () => saveFolderEdit(tag.id, nameInput.value, select.value || null));
    editor.querySelector('[data-action="up"]').addEventListener('click', () => moveFolderOrder(tag.id, -1));
    editor.querySelector('[data-action="down"]').addEventListener('click', () => moveFolderOrder(tag.id, 1));
    editor.querySelector('[data-action="delete"]').addEventListener('click', () => deleteFolder(tag.id));
    container.append(editor);
}

function folderPath(id) {
    const names = [];
    const visited = new Set();
    while (id && !visited.has(id)) {
        visited.add(id);
        const tag = tagById(id);
        if (!tag) break;
        names.unshift(tag.name);
        id = parentOf(id);
    }
    return names.join(' / ');
}

function createFolder(parentId) {
    const name = window.prompt(parentId ? '新建子文件夹名称：' : '新建文件夹名称：')?.trim();
    if (!name) return;
    if (name.length > 25) return window.alert('文件夹名称最多 25 个字符。');
    const existing = tags.find(tag => equalsIgnoreCaseAndAccents(tag.name, name));
    if (existing) return window.alert(`已有同名标签“${existing.name}”。可以在编辑中移动它，不会重复创建。`);
    const tag = makeTag(name);
    if (parentId) settings().folderParents[tag.id] = parentId;
    persist();
    state.editingFolderId = tag.id;
    renderFoldersPage();
}

function saveFolderEdit(id, rawName, newParentId) {
    const tag = tagById(id);
    const name = rawName.trim();
    if (!tag || !name) return window.alert('名称不能为空。');
    if (name.length > 25) return window.alert('名称最多 25 个字符。');
    if (newParentId === id || descendantIds(id).includes(newParentId)) return window.alert('不能把文件夹移进它自己或它的子文件夹。');

    const duplicate = tags.find(item => item.id !== id && equalsIgnoreCaseAndAccents(item.name, name));
    if (duplicate) {
        const confirmed = window.confirm(`已有“${duplicate.name}”。继续会把两个标签合并，所有角色卡与子文件夹都会并入同一个分类。确定吗？`);
        if (!confirmed) return;
        mergeFolders(id, duplicate.id, newParentId);
    } else {
        tag.name = name;
        if (newParentId) settings().folderParents[id] = newParentId;
        else delete settings().folderParents[id];
        persist();
    }
    state.editingFolderId = null;
    refreshNativeTags();
    renderFoldersPage();
}

function mergeFolders(sourceId, targetId, requestedParentId) {
    const value = settings();
    const sourceParent = parentOf(sourceId);
    if (descendantIds(sourceId).includes(targetId)) {
        if (sourceParent) value.folderParents[targetId] = sourceParent;
        else delete value.folderParents[targetId];
    } else if (requestedParentId && requestedParentId !== targetId && !descendantIds(targetId).includes(requestedParentId)) {
        value.folderParents[targetId] = requestedParentId;
    }
    for (const list of Object.values(tag_map)) {
        if (!Array.isArray(list) || !list.includes(sourceId)) continue;
        const replaced = list.map(id => id === sourceId ? targetId : id);
        list.splice(0, list.length, ...new Set(replaced));
    }
    for (const child of childrenOf(sourceId)) {
        if (child.id !== targetId) value.folderParents[child.id] = targetId;
    }
    delete value.folderParents[sourceId];
    value.folderOrder = value.folderOrder.filter(id => id !== sourceId);
    const index = tags.findIndex(item => item.id === sourceId);
    if (index >= 0) tags.splice(index, 1);
    persist();
}

function moveFolderOrder(id, direction) {
    const siblings = childrenOf(parentOf(id));
    const index = siblings.findIndex(tag => tag.id === id);
    const target = siblings[index + direction];
    if (!target) return;
    const order = settings().folderOrder;
    const fromIndex = order.indexOf(id);
    const toIndex = order.indexOf(target.id);
    [order[fromIndex], order[toIndex]] = [order[toIndex], order[fromIndex]];
    persist();
    renderFoldersPage();
}

function deleteFolder(id) {
    const tag = tagById(id);
    if (!tag) return;
    const parentId = parentOf(id);
    const confirmed = window.confirm(`删除文件夹“${tag.name}”？\n\n角色卡不会被删除；这个标签会从角色卡上移除，子文件夹会提升一级。`);
    if (!confirmed) return;
    for (const list of Object.values(tag_map)) {
        if (!Array.isArray(list)) continue;
        const index = list.indexOf(id);
        if (index >= 0) list.splice(index, 1);
    }
    for (const child of childrenOf(id)) {
        if (parentId) settings().folderParents[child.id] = parentId;
        else delete settings().folderParents[child.id];
    }
    delete settings().folderParents[id];
    settings().folderOrder = settings().folderOrder.filter(item => item !== id);
    const tagIndex = tags.findIndex(item => item.id === id);
    if (tagIndex >= 0) tags.splice(tagIndex, 1);
    if (state.currentFolderId === id) state.currentFolderId = parentId;
    state.editingFolderId = null;
    persist();
    refreshNativeTags();
    renderFoldersPage();
}

function renderFoldersPage() {
    const page = document.querySelector('#btm-folders-page');
    if (!page) return;
    cleanupFolderMetadata();
    if (state.currentFolderId && !tagById(state.currentFolderId)) state.currentFolderId = null;
    page.replaceChildren();

    const toolbar = document.createElement('div');
    toolbar.className = 'btm-folder-toolbar';
    const breadcrumbs = document.createElement('nav');
    breadcrumbs.className = 'btm-breadcrumbs';
    renderBreadcrumbs(breadcrumbs);
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btm-primary-small';
    add.textContent = state.currentFolderId ? '＋ 新建子文件夹' : '＋ 新建文件夹';
    add.addEventListener('click', () => createFolder(state.currentFolderId));
    toolbar.append(breadcrumbs, add);
    page.append(toolbar);

    const folderList = document.createElement('div');
    folderList.className = 'btm-folder-list';
    const childFolders = childrenOf(state.currentFolderId);
    for (const folder of childFolders) {
        folderList.append(createFolderRow(folder));
        if (state.editingFolderId === folder.id) renderFolderEditor(folderList, folder);
    }
    if (!childFolders.length) folderList.append(emptyMessage(state.currentFolderId ? '这里还没有子文件夹' : '还没有标签。新建第一个分类吧。'));
    page.append(folderList);

    if (state.currentFolderId) {
        const currentBar = document.createElement('div');
        currentBar.className = 'btm-current-folder-bar';
        const title = document.createElement('h3');
        title.textContent = `“${tagById(state.currentFolderId).name}”里的角色`;
        const toggle = document.createElement('label');
        toggle.innerHTML = '<input type="checkbox"> 仅看本层';
        toggle.querySelector('input').checked = state.onlyCurrentFolder;
        toggle.querySelector('input').addEventListener('change', event => {
            state.onlyCurrentFolder = event.target.checked;
            renderFoldersPage();
        });
        currentBar.append(title, toggle);
        page.append(currentBar);

        const cards = document.createElement('div');
        cards.className = 'btm-folder-cards';
        const folderCharacters = sortedCharacters(charactersForFolder(state.currentFolderId, !state.onlyCurrentFolder));
        for (const character of folderCharacters) cards.append(createCharacterRow(character, { selectable: false }));
        if (!folderCharacters.length) cards.append(emptyMessage('这个分类里还没有角色卡'));
        page.append(cards);
    }

    const danger = document.createElement('details');
    danger.className = 'btm-danger-zone';
    danger.innerHTML = '<summary>危险操作</summary><p>清空所有标签会先下载备份，不会删除角色卡。</p><button type="button">清空全部标签</button>';
    danger.querySelector('button').addEventListener('click', clearAllTags);
    page.append(danger);
}

function clearAllTags() {
    if (!tags.length && !Object.values(tag_map).some(value => Array.isArray(value) && value.length)) {
        return window.alert('目前没有需要清空的标签。');
    }
    const confirmed = window.confirm('清空所有角色与群组的标签和分类结构？\n\n此操作会先下载一份标签备份，不会删除角色卡。');
    if (!confirmed) return;
    try {
        const backup = new Blob([JSON.stringify({ tags, tag_map }, null, 2)], { type: 'application/json' });
        const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
        download(backup, `bulk-tags-before-clear-${date}.json`, 'application/json');
        tags.splice(0, tags.length);
        for (const key of Object.keys(tag_map)) delete tag_map[key];
        extension_settings[EXTENSION_KEY] = { schemaVersion: 2, folderParents: {}, folderOrder: [] };
        state.currentFolderId = null;
        state.editingFolderId = null;
        refreshNativeTags();
        renderCharacterList();
        renderFoldersPage();
        window.alert('旧标签已清空，备份文件已经下载。');
    } catch (error) {
        console.error('[角色卡整理器] 清空失败', error);
        window.alert('清空失败，请查看浏览器控制台。');
    }
}

function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
}

function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.btm-tab').forEach(button => button.classList.toggle('btm-active', button.dataset.tab === tab));
    document.querySelector('#btm-characters-page').hidden = tab !== 'characters';
    document.querySelector('#btm-folders-page').hidden = tab !== 'folders';
    if (tab === 'characters') renderCharacterList();
    else renderFoldersPage();
}

function closePanel() {
    const root = document.querySelector(selectors.root);
    if (root) root.hidden = true;
    document.body.classList.remove('btm-open');
}

function openPanel() {
    const root = document.querySelector(selectors.root);
    if (!root) return;
    root.hidden = false;
    document.body.classList.add('btm-open');
    cleanupFolderMetadata();
    renderPreview();
    switchTab(state.tab);
    document.querySelector(selectors.search)?.focus();
}

function createPanel() {
    if (document.querySelector(selectors.root)) return;
    const root = document.createElement('div');
    root.id = 'btm-root';
    root.hidden = true;
    root.innerHTML = `
        <div class="btm-backdrop" aria-hidden="true"></div>
        <section class="btm-panel" role="dialog" aria-modal="true" aria-labelledby="btm-title">
            <header class="btm-header">
                <h2 id="btm-title">角色管理器</h2>
                <button id="btm-close" type="button" aria-label="关闭">✕</button>
            </header>
            <nav class="btm-tabs" aria-label="功能页面">
                <button type="button" class="btm-tab btm-active" data-tab="characters">角色管理</button>
                <button type="button" class="btm-tab" data-tab="folders">分类文件夹</button>
            </nav>
            <section id="btm-characters-page" class="btm-page">
                <div class="btm-toolbar">
                    <div class="btm-search-sort">
                        <input id="btm-search" type="search" placeholder="搜索角色名或已有标签" aria-label="搜索角色名或已有标签">
                        <select id="btm-sort" aria-label="排序方式">
                            <option value="recent">最近玩</option>
                            <option value="newest">最新加</option>
                            <option value="az">A → Z</option>
                            <option value="za">Z → A</option>
                        </select>
                    </div>
                    <div class="btm-selection-bar">
                        <span id="btm-count"></span>
                        <button id="btm-select-visible" type="button">全选结果</button>
                        <button id="btm-clear-selection" type="button">取消选择</button>
                    </div>
                </div>
                <div id="btm-character-list" class="btm-list"></div>
                <div class="btm-composer">
                    <label for="btm-tags-input">给已选角色添加标签</label>
                    <textarea id="btm-tags-input" rows="2" placeholder="例如：年下 狗男，温柔"></textarea>
                    <div id="btm-preview" class="btm-preview"></div>
                    <div id="btm-status" class="btm-status" role="status" aria-live="polite"></div>
                    <div class="btm-primary-actions">
                        <button id="btm-apply" type="button">添加到已选角色</button>
                    </div>
                    <div class="btm-delete-row">
                        <button id="btm-delete-selected" type="button" class="btm-danger">删除已选角色</button>
                        <label class="btm-delete-chats"><input id="btm-delete-chats" type="checkbox"> 同时删除聊天记录</label>
                    </div>
                </div>
            </section>
            <section id="btm-folders-page" class="btm-page" hidden></section>
        </section>`;
    document.body.append(root);

    root.querySelector('#btm-close').addEventListener('click', closePanel);
    root.querySelector('.btm-backdrop').addEventListener('click', closePanel);
    root.querySelectorAll('.btm-tab').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
    root.querySelector(selectors.search).addEventListener('input', renderCharacterList);
    root.querySelector('#btm-sort').addEventListener('change', event => {
        state.sort = event.target.value;
        renderCharacterList();
    });
    root.querySelector(selectors.input).addEventListener('input', () => { renderPreview(); setStatus(''); });
    root.querySelector('#btm-apply').addEventListener('click', applyTags);
    root.querySelector('#btm-delete-selected').addEventListener('click', deleteSelectedCharacters);
    root.querySelector('#btm-select-visible').addEventListener('click', () => {
        for (const character of visibleCharacters()) selectedAvatars.add(character.avatar);
        renderCharacterList();
    });
    root.querySelector('#btm-clear-selection').addEventListener('click', () => {
        selectedAvatars.clear();
        renderCharacterList();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !root.hidden) closePanel();
    });
}

export function init() {
    const toolbar = document.querySelector('#rm_print_characters_pagination');
    if (!toolbar) return;
    bindRecentTracker();
    createPanel();
    let button = document.querySelector('#btm-open');
    if (!button) {
        button = document.createElement('i');
        button.id = 'btm-open';
        button.className = 'menu_button fa-solid fa-layer-group';
        button.title = '角色管理器';
        button.setAttribute('aria-label', '打开角色管理器');
        button.setAttribute('role', 'button');
        button.tabIndex = 0;
        button.addEventListener('click', openPanel);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') openPanel();
        });
    }

    const editButton = toolbar.querySelector('#bulkEditButton');
    if (editButton) {
        if (button.previousElementSibling !== editButton) editButton.insertAdjacentElement('afterend', button);
    } else if (button.parentElement !== toolbar) {
        toolbar.append(button);
    }
}

// 兼容 SillyTavern 1.16：分页工具栏可能晚于扩展加载，也可能被重新绘制。
setInterval(init, 1200);
