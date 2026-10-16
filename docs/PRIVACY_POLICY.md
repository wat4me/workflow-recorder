# 流程录制隐私政策 / Workflow Recorder Privacy Policy

> 生效日期 / Effective date：2026-10-10  
> 开发者 / Developer：wat4me  
> 联系方式 / Contact：wat4mefoxmail@gmail.com

## 中文

### 1. 产品用途

流程录制用于在用户明确启动录制后，记录用户选择的网页及其打开的子页面中的操作步骤和页面截图，并在用户设备本地生成、保存、预览和导出结构化流程文档。

### 2. 处理的数据

扩展可能处理以下数据：

- 浏览信息：用户纳入录制范围的网页网址、页面标题和页面之间的打开关系。
- 用户活动：点击、文本输入、选择、按键、悬停、拖拽和页面跳转。
- 网站内容：页面元素标签、有限属性、ARIA 属性、浏览器计算的可访问性角色、名称、描述、值和状态、有限父级可访问性上下文、附近文本、有限 DOM 上下文和页面截图。
- 表单内容：用户在录制期间输入或选择的值。包括密码输入框的实际输入值。
- 可能出现在用户所选网页、输入值或截图中的个人身份信息、身份验证信息、个人通信、财务与支付信息、健康信息或位置信息。

扩展只处理用户主动开始录制的根页面及由该页面打开并纳入同一录制链路的后代标签页或窗口，不以构建完整浏览历史为目的处理其他标签页。

### 3. 使用目的

上述数据仅用于提供扩展的单一用途：生成录制步骤、步骤截图、已保存用例和用户主动下载的导出文件。数据不用于广告、跨站跟踪、用户画像、确定信用状况或贷款决策。对用户数据的使用遵守 Chrome Web Store 用户数据政策及 Limited Use 要求。

### 4. 存储、传输和共享

操作步骤、历史用例和运行状态保存在当前 Chrome 用户配置文件的 chrome.storage.local 中；截图 Blob 保存在扩展专用 IndexedDB 中。

扩展不将录制数据发送到开发者服务器或第三方服务器，不出售、出租或共享录制数据，也不加载或执行远程代码。用户主动导出的 ZIP 文件会保存到用户选择或浏览器配置的下载位置，之后由用户自行控制和处理。

### 5. 保留与删除

用户可以在扩展界面中删除步骤或历史用例。扩展会清理不再被当前录制或其他已保存用例引用的截图；仍被其他记录引用的截图会继续保留。清理失败时会在后台重试，因此底层截图可能延迟删除。用户也可以通过清除扩展数据、删除对应 Chrome 用户配置文件或卸载扩展移除本地数据。开发者无法远程访问或删除这些本地数据。

### 6. 用户选择与注意事项

录制仅在用户点击“开始录制”后进行，并在用户点击“停止录制”后停止。用户不应录制不希望保存在本机或包含在导出文件中的账号密码、支付信息、健康信息、个人通信或其他敏感内容。Chrome 可能在录制期间显示调试提示，这是扩展读取操作目标的局部可访问性信息以及在启用截图时接收页面帧的浏览器行为。关闭截图不关闭可访问性采集，停止录制后会断开调试连接。

### 7. 儿童隐私

本扩展不面向儿童，也不会故意为了营销、画像或广告目的收集儿童个人信息。

### 8. 政策变更

如果数据处理方式发生变化，我们会更新本政策，并在扩展内按适用政策向用户显著说明变化。新版本的生效日期将显示在本页顶部。

### 9. 联系我们

如对本政策或本地数据处理有疑问，请联系：wat4mefoxmail@gmail.com。

## English

### 1. Purpose

Workflow Recorder records interaction steps and page screenshots from a web page explicitly selected by the user and descendant pages opened from it. It locally generates, stores, previews, and exports structured workflow documentation.

### 2. Data handled

The extension may handle:

- Browsing information: URLs, page titles, and opening relationships between pages included in a recording.
- User activity: clicks, text input, selections, key presses, hovers, drags, and navigation.
- Website content: element tags, limited attributes, ARIA attributes, browser-computed accessibility roles, names, descriptions, values and states, limited ancestor accessibility context, nearby text, limited DOM context, and page screenshots.
- Form content: values typed or selected during recording. This includes actual values entered into password fields.
- Personal identification, authentication information, personal communications, financial and payment information, health information, or location information that may appear in a user-selected page, input value, or screenshot.

The extension processes only the user-selected root page and descendant tabs or windows admitted to the same recording tree. It does not process unrelated tabs for the purpose of building a complete browsing history.

### 3. Use of data

The data is used only for the extension's single purpose: generating recorded steps, step screenshots, saved workflow cases, and export files requested by the user. It is not used for advertising, cross-site tracking, user profiling, creditworthiness, or lending decisions. Use of user data follows the Chrome Web Store User Data Policy, including its Limited Use requirements.

### 4. Storage, transmission, and sharing

Interaction steps, saved cases, and runtime state are stored in chrome.storage.local in the current Chrome profile. Screenshot blobs are stored in extension-specific IndexedDB storage.

The extension does not transmit recorded data to the developer or third-party servers, sell, rent, or share recorded data, or load and execute remote code. ZIP files exported by the user are saved to the user's selected or browser-configured download location and are thereafter controlled by the user.

### 5. Retention and deletion

Users can delete steps or saved cases in the extension interface. The extension cleans up screenshots no longer referenced by the current recording or other saved cases. Screenshots still referenced elsewhere are retained. Failed cleanup is retried in the background, so underlying screenshots may be deleted later. Users can also remove local data by clearing extension data, deleting the applicable Chrome profile, or uninstalling the extension. The developer cannot remotely access or delete this local data.

### 6. User choice and precautions

Recording begins only after the user clicks “Start recording” and stops after the user clicks “Stop recording.” Users should not record credentials, payment information, health information, private communications, or other sensitive content they do not want stored locally or included in export files. Chrome may display a debugger notification during recording because the extension reads local accessibility context for operation targets and, when screenshots are enabled, receives page frames. Accessibility collection continues with screenshots off; the debugger is detached when recording stops.

### 7. Children's privacy

The extension is not directed to children and does not intentionally collect children's personal information for marketing, profiling, or advertising.

### 8. Changes

If data practices change, this policy will be updated and users will receive a prominent in-product disclosure when required. The effective date of the current version appears at the top of this page.

### 9. Contact

For questions about this policy or local data handling, contact: wat4mefoxmail@gmail.com.
