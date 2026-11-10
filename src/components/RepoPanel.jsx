import React from 'react';
import RepoSection from './RepoSection.jsx';

/**
 * 阅读器右侧的「码仓」面板：绑定 / 克隆 / 浏览仓库文件都在里面，
 * 和文献详情弹窗共用同一套 RepoSection，行为完全一致。
 */
export default function RepoPanel({ docId, onClose }) {
  return (
    <aside className="repo-panel">
      <div className="anno-panel-head">
        <strong className="anno-panel-title">代码仓库</strong>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose} title="收起码仓面板">
          ✕
        </button>
      </div>
      <div className="repo-panel-body">
        <RepoSection docId={docId} compact />
      </div>
    </aside>
  );
}
