import React, { useEffect, useMemo, useState } from 'react';
import { api, guard, toast } from '../api.js';

/** 文献详情编辑：元数据、分类、星标、标签 */
export default function DocDialog({ doc, folders, allTags = [], onCreateFolder, onClose, onSaved, onOpen }) {
  const [form, setForm] = useState({
    title: doc.title || '',
    authors: doc.authors || '',
    year: doc.year || '',
    journal: doc.journal || '',
    doi: doc.doi || '',
    abstract: doc.abstract || '',
    folder_id: doc.folder_id || '',
    star: doc.star || 0,
  });
  const [tags, setTags] = useState(doc.tags || []);
  const [tagInput, setTagInput] = useState('');

  /** 已有但还没打在这篇文献上的标签，供下拉直接选择 */
  const pickableTags = useMemo(() => {
    const attached = new Set(tags.map((t) => String(t.id)));
    return (allTags || [])
      .filter((t) => t && !attached.has(String(t.id)))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
  }, [allTags, tags]);
  const [saving, setSaving] = useState(false);
  const [filling, setFilling] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  /**
   * 智能 DOI 补全：一次走完
   * PDF 元数据 → 正文识别 DOI → OpenAlex/Crossref 抓标题/作者/期刊/年份/摘要。
   * 空字段直接填；要覆盖已有内容先弹确认（只有拿到网络数据时才允许覆盖）。
   */
  const runSmartFill = async () => {
    setFilling(true);
    try {
      const res = await api.docs.smartFill(doc.id);
      const meta = (res && res.meta) || {};
      const labels = { title: '标题', authors: '作者', year: '年份', journal: '期刊', doi: 'DOI', abstract: '摘要' };
      const show = (v) => {
        const s = String(v == null ? '' : v);
        return s.length > 20 ? `${s.slice(0, 20)}…` : s;
      };
      const fills = [];
      const overwriteLines = [];
      const patch = {};

      for (const [field, label] of Object.entries(labels)) {
        const next = meta[field];
        if (next === null || next === undefined || String(next).trim() === '') continue;
        const cur = form[field] ?? '';
        const curEmpty = cur === null || cur === undefined || String(cur).trim() === '';
        const same =
          String(cur).trim() === String(next).trim() ||
          (field === 'year' && Number(cur) === Number(next)) ||
          (field === 'doi' && String(cur).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') === String(next).trim());
        if (same) continue;
        // 没有网络数据时只补空缺，绝不覆盖用户已填内容
        if (!curEmpty && !res.hasWeb) continue;
        patch[field] = field === 'year' ? Number(next) || cur : next;
        if (curEmpty) fills.push(label);
        else overwriteLines.push(`${label}：${show(cur)} → ${show(next)}`);
      }

      if (!Object.keys(patch).length) {
        if (!res.foundDoi) {
          toast('PDF 里没找到 DOI（可能是扫描版），也没解析到新信息，请手动填写', 'warn', 5000);
        } else if (!res.hasWeb) {
          toast(`找到 DOI：${res.doi}，但网络查询失败，只补全了本地解析结果`, 'warn', 5000);
        } else {
          toast('网络信息与当前内容一致，没有要补的字段', 'warn');
        }
        return;
      }

      if (overwriteLines.length) {
        const ok = window.confirm(`将覆盖已有内容：\n${overwriteLines.join('\n')}\n\n继续？`);
        if (!ok) return;
      }

      const updated = await api.docs.update(doc.id, patch);
      setForm((prev) => ({ ...prev, ...patch }));
      const sourceName = res.source === 'crossref' ? 'Crossref' : res.source === 'openalex' ? 'OpenAlex' : 'PDF';
      const doiTip = res.doiSource === 'pdf-text' ? '，DOI 从正文识别' : '';
      const changedLabels = fills.concat(overwriteLines.map((s) => s.split('：')[0]));
      toast(`智能补全完成（${sourceName}${doiTip}）：${changedLabels.join('、')}`, 'success', 4000);
      if (updated) onSaved(updated);
    } catch (err) {
      toast(err.message || '智能补全失败', 'error');
    } finally {
      setFilling(false);
    }
  };

  /** 就地新建分类：写库成功后直接选中，无需先去侧边栏创建 */
  const createFolderInline = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const folder = await onCreateFolder(name);
    if (!folder) return;
    setForm((prev) => ({ ...prev, folder_id: String(folder.id) }));
    setNewFolderName('');
    setNewFolderOpen(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        ...form,
        year: form.year === '' ? null : Number(form.year),
        folder_id: form.folder_id === '' ? null : Number(form.folder_id),
        star: Number(form.star) || 0,
      };
      const updated = await api.docs.update(doc.id, payload);
      toast('文献信息已保存', 'success');
      onSaved(updated);
      onClose();
    } catch (err) {
      toast(err.message || '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const addTag = async () => {
    const name = tagInput.trim();
    if (!name) return;
    const tag = await guard(() => api.tags.attach(doc.id, name));
    if (tag) {
      setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      setTagInput('');
      onSaved(null, true);
    }
  };

  /** 从下拉里选一个已有标签：直接挂到这篇文献上（后端同名会复用，不会重复创建） */
  const attachExistingTag = async (name) => {
    if (!name) return;
    const tag = await guard(() => api.tags.attach(doc.id, name));
    if (tag) {
      setTags((prev) => (prev.some((t) => t.id === tag.id) ? prev : [...prev, tag]));
      onSaved(null, true);
    }
  };

  const removeTag = async (tagId) => {
    const ok = await guard(() => api.tags.detach(doc.id, tagId));
    if (ok) {
      setTags((prev) => prev.filter((t) => t.id !== tagId));
      onSaved(null, true);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>文献详情</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {(doc.stored_path || doc.file_name) && (
            <div className="doc-file">
              <span className="doc-file-label">文件</span>
              <code className="doc-file-path" title={doc.stored_path || doc.file_name}>
                {doc.stored_path || doc.file_name}
              </code>
              <button type="button" className="ghost-btn tiny" onClick={() => api.docs.reveal(doc.id)}>
                在文件夹中显示
              </button>
            </div>
          )}

          <div className="meta-tools">
            <button type="button" className="ghost-btn tiny" onClick={runSmartFill} disabled={filling}>
              {filling ? '补全中…' : '✨ 智能 DOI 补全'}
            </button>
            <span className="meta-tools-hint">
              自动读 PDF 元数据 → 从正文识别 DOI → 按 DOI 从 OpenAlex / Crossref 抓标题、作者、期刊、年份、摘要；
              只补空缺，覆盖已有内容前会先确认
            </span>
          </div>

          <label className="field">
            <span>标题</span>
            <input value={form.title} onChange={(e) => setField('title', e.target.value)} />
          </label>

          <div className="field-row">
            <label className="field">
              <span>作者</span>
              <input value={form.authors} onChange={(e) => setField('authors', e.target.value)} placeholder="多位作者用 ; 分隔" />
            </label>
            <label className="field narrow">
              <span>年份</span>
              <input value={form.year} onChange={(e) => setField('year', e.target.value)} placeholder="2024" />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>期刊 / 会议</span>
              <input value={form.journal} onChange={(e) => setField('journal', e.target.value)} />
            </label>
            <label className="field">
              <span>DOI</span>
              <input value={form.doi} onChange={(e) => setField('doi', e.target.value)} placeholder="10.xxxx/xxxxx" />
            </label>
          </div>

          <div className="field-row">
            <div className="field">
              <span>分类</span>
              <div className="select-with-add">
                <select value={form.folder_id} onChange={(e) => setField('folder_id', e.target.value)}>
                  <option value="">未分类</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                {onCreateFolder && (
                  <button
                    type="button"
                    className="ghost-btn tiny"
                    title="新建分类"
                    onClick={() => setNewFolderOpen((v) => !v)}
                  >
                    ＋
                  </button>
                )}
              </div>
              {newFolderOpen && (
                <div className="meta-form inline">
                  <input
                    autoFocus
                    className="meta-form-input"
                    value={newFolderName}
                    placeholder="新分类名称，回车创建"
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        createFolderInline();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setNewFolderOpen(false);
                      }
                    }}
                  />
                  <div className="meta-form-actions">
                    <button type="button" className="ghost-btn tiny" onClick={createFolderInline}>
                      创建
                    </button>
                    <button type="button" className="ghost-btn tiny" onClick={() => setNewFolderOpen(false)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
            <label className="field narrow">
              <span>星标</span>
              <select value={form.star} onChange={(e) => setField('star', e.target.value)}>
                {[0, 1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? '无' : '★'.repeat(n)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="field">
            <span>摘要</span>
            <textarea rows={4} value={form.abstract} onChange={(e) => setField('abstract', e.target.value)} />
          </label>

          <div className="field">
            <span>标签</span>
            <div className="tag-editor">
              {tags.map((tag) => (
                <span key={tag.id} className="tag-chip" style={{ borderColor: tag.color, color: tag.color }}>
                  #{tag.name}
                  <button className="tag-remove" onClick={() => removeTag(tag.id)}>
                    ✕
                  </button>
                </span>
              ))}
              <select
                className="tag-select"
                value=""
                onChange={(e) => attachExistingTag(e.target.value)}
                title="从已有标签里选择一个"
                disabled={!pickableTags.length}
              >
                <option value="">{pickableTags.length ? '＋ 选择已有标签…' : '＋ 暂无其他已有标签'}</option>
                {pickableTags.map((tag) => (
                  <option key={tag.id} value={tag.name}>
                    #{tag.name}
                  </option>
                ))}
              </select>
              <input
                className="tag-input"
                placeholder="或输入新标签名，回车创建"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addTag();
                  }
                }}
              />
            </div>
          </div>
        </div>

        <footer className="modal-foot">
          <button className="ghost-btn" onClick={() => onOpen(doc)}>
            打开阅读
          </button>
          <div className="spacer" />
          <button className="ghost-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}
