-- ---------------------------------------------------------------------------
-- paper-reader 数据库结构
-- 命名规范：pr_（作用域前缀） + 功能名 + _info（主数据）/ _rd（record 记录）
-- 说明：MySQL 在 Windows 上默认 lower_case_table_names=1，会把表名统一存为小写，
--      因此规范中的 _Rd 在库内落地为小写 _rd，语义不变。
-- 字符集：utf8mb4 / utf8mb4_unicode_ci，引擎 InnoDB
-- ---------------------------------------------------------------------------

-- 1. 分类（文献夹）主数据
CREATE TABLE IF NOT EXISTS pr_folder_info (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '分类ID',
  name        VARCHAR(128)    NOT NULL                COMMENT '分类名称',
  parent_id   BIGINT UNSIGNED NULL                    COMMENT '上级分类ID，NULL 为根',
  sort_no     INT             NOT NULL DEFAULT 0      COMMENT '排序号',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pr_folder_info_parent (parent_id),
  UNIQUE KEY uk_pr_folder_info_name (parent_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文献分类信息表';

-- 2. 文献主数据
CREATE TABLE IF NOT EXISTS pr_doc_info (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '文献ID',
  title        VARCHAR(512)    NOT NULL                COMMENT '标题',
  authors      VARCHAR(512)    NULL                    COMMENT '作者（多作者以 ; 分隔）',
  year         SMALLINT        NULL                    COMMENT '年份',
  journal      VARCHAR(256)    NULL                    COMMENT '期刊/会议',
  doi          VARCHAR(191)    NULL                    COMMENT 'DOI',
  abstract     TEXT            NULL                    COMMENT '摘要',
  file_name    VARCHAR(255)    NOT NULL                COMMENT '文库内文件名（不含目录）',
  stored_path  VARCHAR(512)    NULL                    COMMENT '库内相对路径（含分类目录，/ 分隔）',
  orig_name    VARCHAR(255)    NULL                    COMMENT '导入时的原始文件名',
  file_hash    CHAR(64)        NOT NULL                COMMENT '源文件 SHA-256，用于去重',
  file_size    BIGINT UNSIGNED NOT NULL DEFAULT 0      COMMENT '文件字节数',
  page_count   INT             NOT NULL DEFAULT 0      COMMENT '总页数',
  thumb_data   MEDIUMBLOB      NULL                    COMMENT '首页缩略图（JPEG）',
  folder_id    BIGINT UNSIGNED NULL                    COMMENT '所属分类',
  star         TINYINT         NOT NULL DEFAULT 0      COMMENT '星标 0-5',
  last_page    INT             NOT NULL DEFAULT 1      COMMENT '上次阅读页码',
  last_read_at DATETIME        NULL                    COMMENT '最近阅读时间',
  read_seconds INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '累计阅读秒数',
  anno_count   INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '批注数量（冗余统计）',
  is_deleted   TINYINT         NOT NULL DEFAULT 0      COMMENT '逻辑删除标记',
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_pr_doc_info_hash (file_hash),
  KEY idx_pr_doc_info_folder (folder_id),
  KEY idx_pr_doc_info_last_read (last_read_at),
  KEY idx_pr_doc_info_created (created_at),
  KEY idx_pr_doc_info_title (title(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文献信息表';

-- 3. 标签主数据
CREATE TABLE IF NOT EXISTS pr_tag_info (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '标签ID',
  name       VARCHAR(64)     NOT NULL                COMMENT '标签名',
  color      VARCHAR(16)     NOT NULL DEFAULT '#5b8def' COMMENT '标签颜色',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_pr_tag_info_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='标签信息表';

-- 4. 文献-标签 关联记录
CREATE TABLE IF NOT EXISTS pr_doc_tag_rd (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '关联记录ID',
  doc_id     BIGINT UNSIGNED NOT NULL                COMMENT '文献ID',
  tag_id     BIGINT UNSIGNED NOT NULL                COMMENT '标签ID',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '打标时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_pr_doc_tag_rd (doc_id, tag_id),
  KEY idx_pr_doc_tag_rd_tag (tag_id),
  CONSTRAINT fk_pr_doc_tag_rd_doc FOREIGN KEY (doc_id) REFERENCES pr_doc_info (id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_doc_tag_rd_tag FOREIGN KEY (tag_id) REFERENCES pr_tag_info (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文献标签关联记录表';

-- 5. 标注（高亮 / 下划线 / 删除线 / 框选 / 手绘 / 便签）主数据
CREATE TABLE IF NOT EXISTS pr_anno_info (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '标注ID',
  doc_id     BIGINT UNSIGNED NOT NULL                COMMENT '文献ID',
  page_no    INT             NOT NULL                COMMENT '页码（从 1 开始）',
  anno_type  VARCHAR(16)     NOT NULL                COMMENT 'highlight/underline/strike/box/ink/note',
  color      VARCHAR(16)     NOT NULL DEFAULT '#ffd400' COMMENT '标注颜色',
  rects      JSON            NULL                    COMMENT '矩形集合（PDF 用户坐标归一化）',
  ink_paths  JSON            NULL                    COMMENT '手绘路径（PDF 用户坐标归一化）',
  quote      TEXT            NULL                    COMMENT '被标注的原文',
  content    TEXT            NULL                    COMMENT '批注内容',
  opacity    DECIMAL(4,2)    NOT NULL DEFAULT 0.35   COMMENT '不透明度',
  seq_no     INT             NOT NULL DEFAULT 0      COMMENT '页内序号',
  is_deleted TINYINT         NOT NULL DEFAULT 0      COMMENT '逻辑删除标记',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pr_anno_info_doc_page (doc_id, page_no),
  KEY idx_pr_anno_info_type (anno_type),
  CONSTRAINT fk_pr_anno_info_doc FOREIGN KEY (doc_id) REFERENCES pr_doc_info (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='PDF标注信息表';

-- 6. 批注回复记录
CREATE TABLE IF NOT EXISTS pr_anno_reply_rd (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '回复ID',
  anno_id    BIGINT UNSIGNED NOT NULL                COMMENT '标注ID',
  author     VARCHAR(64)     NOT NULL DEFAULT '我'    COMMENT '回复人',
  content    TEXT            NOT NULL                COMMENT '回复内容',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '回复时间',
  PRIMARY KEY (id),
  KEY idx_pr_anno_reply_rd_anno (anno_id, created_at),
  CONSTRAINT fk_pr_anno_reply_rd_anno FOREIGN KEY (anno_id) REFERENCES pr_anno_info (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='标注回复记录表';

-- 7. 书签主数据
CREATE TABLE IF NOT EXISTS pr_bookmark_info (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '书签ID',
  doc_id     BIGINT UNSIGNED NOT NULL                COMMENT '文献ID',
  page_no    INT             NOT NULL                COMMENT '页码',
  label      VARCHAR(128)    NULL                    COMMENT '书签说明',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pr_bookmark_info_doc (doc_id, page_no),
  CONSTRAINT fk_pr_bookmark_info_doc FOREIGN KEY (doc_id) REFERENCES pr_doc_info (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='阅读书签信息表';

-- 8. 阅读记录（每次打开文献产生一条）
CREATE TABLE IF NOT EXISTS pr_read_rd (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '阅读记录ID',
  doc_id       BIGINT UNSIGNED NOT NULL                COMMENT '文献ID',
  start_page   INT             NOT NULL DEFAULT 1      COMMENT '开始页码',
  end_page     INT             NOT NULL DEFAULT 1      COMMENT '结束页码',
  duration_sec INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '本次阅读时长（秒）',
  opened_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '打开时间',
  closed_at    DATETIME        NULL                    COMMENT '关闭时间',
  PRIMARY KEY (id),
  KEY idx_pr_read_rd_doc (doc_id, opened_at),
  KEY idx_pr_read_rd_time (opened_at),
  CONSTRAINT fk_pr_read_rd_doc FOREIGN KEY (doc_id) REFERENCES pr_doc_info (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='文献阅读记录表';

-- 9. 导出记录
CREATE TABLE IF NOT EXISTS pr_export_rd (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '导出记录ID',
  doc_id      BIGINT UNSIGNED NULL                    COMMENT '文献ID（可为空表示批量导出）',
  export_type VARCHAR(16)     NOT NULL                COMMENT 'markdown/pdf/jpeg',
  file_path   VARCHAR(1024)   NOT NULL                COMMENT '导出文件路径',
  anno_count  INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '随附批注数量',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '导出时间',
  PRIMARY KEY (id),
  KEY idx_pr_export_rd_doc (doc_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='标注导出记录表';

-- 10. 笔记主数据
CREATE TABLE IF NOT EXISTS pr_note_info (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '笔记ID',
  title        VARCHAR(256)    NOT NULL DEFAULT ''      COMMENT '笔记标题',
  content      LONGTEXT        NULL                     COMMENT '笔记内容（Markdown 源码）',
  html_content LONGTEXT        NULL                     COMMENT '渲染后的 HTML（便于搜索）',
  doc_id       BIGINT UNSIGNED NULL                     COMMENT '关联文献ID（可为空）',
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  is_deleted   TINYINT         NOT NULL DEFAULT 0       COMMENT '逻辑删除标记',
  PRIMARY KEY (id),
  KEY idx_pr_note_info_doc (doc_id),
  KEY idx_pr_note_info_updated (updated_at),
  CONSTRAINT fk_pr_note_info_doc FOREIGN KEY (doc_id) REFERENCES pr_doc_info (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='笔记信息表';

-- 11. 应用设置主数据
CREATE TABLE IF NOT EXISTS pr_setting_info (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '设置ID',
  setting_key   VARCHAR(64)     NOT NULL                COMMENT '配置键',
  setting_value TEXT            NULL                    COMMENT '配置值（JSON 或字符串）',
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_pr_setting_info_key (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='应用设置信息表';

-- 默认设置（幂等写入）
INSERT INTO pr_setting_info (setting_key, setting_value) VALUES
  ('default_highlight_color', '#ffd400'),
  ('default_highlight_opacity', '0.35'),
  ('reader_theme', 'dark'),
  ('schema_version', '1')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

-- 11. 页面译文缓存（「一键翻译」的本地持久化）
-- 原文指纹变化时旧缓存自然失效，不阻塞重新翻译
CREATE TABLE IF NOT EXISTS pr_page_translate_rd (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '记录ID',
  doc_id      BIGINT UNSIGNED NOT NULL                COMMENT '文献ID',
  page_no     INT             NOT NULL                COMMENT '页码（从 1 开始）',
  target_lang VARCHAR(16)     NOT NULL DEFAULT 'zh'   COMMENT '目标语言',
  source_hash VARCHAR(32)     NOT NULL                COMMENT '该页原文指纹，原文变化后缓存失效',
  payload     JSON            NOT NULL                COMMENT '译文段落（归一化坐标 + 字号 + 文本）',
  block_count INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '段落数',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_pr_page_translate (doc_id, page_no, target_lang, source_hash),
  KEY idx_pr_page_translate_doc (doc_id, target_lang),
  CONSTRAINT fk_pr_page_translate_doc FOREIGN KEY (doc_id) REFERENCES pr_doc_info (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='页面译文缓存表';