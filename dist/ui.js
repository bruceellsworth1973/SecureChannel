/* global Helpers */
class UI
{
	static trapFocus(form)
	{
		const selectors = 'a[href]:not([disabled]), button:not([disabled]):not(.noflow), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled])';
		const nodes = UI.findAll(form, selectors);
		const cancelButton = UI.find(form, 'button[data-purpose="cancel"]') ||  UI.find(form, 'button.btn-danger') || UI.find(form, 'button.btn-warning') || UI.find(form, 'button.btn-cancel');
		const confirmButton = UI.find(form, 'button[data-purpose="confirm"]') || UI.find(form, 'button.btn-primary') || UI.find(form, 'button.btn-confirm');
		if (nodes.length)
		{
			const TAB = 9, ESCAPE = 27, ENTER = 13;
			const first = nodes[0];
			const last = nodes[nodes.length -1];
			const defaultFocus = confirmButton || first;
			const focus = node => {
				setTimeout(() => node.focus(), 100);
			};
			const onTab = (shiftKey, event) => {
				const {activeElement} = document;
				if ((!shiftKey && activeElement === last) || (shiftKey && activeElement === first))
				{
					UI.consumeEvent(event);
					focus(shiftKey ? last : first);
				}
			};
			const onEscape = event => {
				if (cancelButton)
				{
					UI.consumeEvent(event);
					UI.click(cancelButton);
				}
			};
			const onEnter = event => {
				const {activeElement} = document;
				// Only trigger if not already on a button or in a textarea
				if (confirmButton && activeElement.tagName !== 'BUTTON' && activeElement.tagName !== 'TEXTAREA')
				{
					UI.consumeEvent(event);
					UI.click(confirmButton);
				}
			};
			const trapFocus = (event = {}) => {
				const {key, charCode, keyCode, shiftKey} = event;
				const code = charCode || keyCode;
				const tabKey = (key === 'Tab' || code === TAB);
				const escapeKey = (key === 'Escape' || code === ESCAPE);
				const enterKey = (key === 'Enter' || code === ENTER);
				switch (true)
				{
					case tabKey: return onTab(shiftKey, event);
					case escapeKey: return onEscape(event);
					case enterKey: return onEnter(event);
				}
			};
			form.addEventListener('keydown', trapFocus, {passive:false});
			return {focusForm:() => focus(defaultFocus), removeTrap:() => form.removeEventListener('keydown', trapFocus)};
		}
		return {};
	}
	static createCookie(name, value, days)
	{
		let expires = '';
		if (days)
		{
			const moment = new Date();
			moment.setTime(moment.getTime() + (days*24*60*60*1000));
			expires = `; expires=${moment.toGMTString()}`;
		}
		document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}${expires}; SameSite=Strict; path=/`;
	}
	static readCookie(name)
	{
		const nameEQ = `${encodeURIComponent(name)}=`;
		const ca = document.cookie.split(';');
		for (let i = 0; i < ca.length; i++)
		{
			let c = ca[i];
			while (c.charAt(0) === ' ') {c = c.substring(1, c.length);}
			if (c.indexOf(nameEQ) === 0) {return decodeURIComponent(c.substring(nameEQ.length, c.length));}
		}
		return null;
	}
	static eraseCookie(name)
	{
		UI.createCookie(name, '', -1);
	}
	static getSearchParams()
	{
		return Object.fromEntries(new URLSearchParams(window.location.search));
	}
	static setSearchParams(params, replace = false)
	{
		const {title} = window.document;
		const {isUndefined, iterable} = Helpers;
		const reducer = (arr, [key, val]) => isUndefined(val) ? arr : ([...arr, `${key}=${val}`]);
		const search = '?' + iterable(params).reduce(reducer, []).join('&');
		replace ? history.replaceState(null, title, search) : history.pushState(null, title, search);
		return params;
	}
	static getHashParams()
	{
		return Object.fromEntries(new URLSearchParams(window.location.hash.substring(1)));
	}
	static setHashParams(params, replace = false)
	{
		const {title} = window.document;
		const {isUndefined, iterable} = Helpers;
		const reducer = (arr, [key, val]) => (isUndefined(val) || val === 'undefined') ? arr : ([...arr, `${key}=${val}`]);
		const hash = '#' + iterable(params).reduce(reducer, []).join('&');
		const url = location.origin + location.pathname + location.search + hash;
		replace ? history.replaceState(null, title, url) : history.pushState(null, title, url);
		return params;
	}
	static appendHashHistory(state)
	{
		const {isUndefined, iterable} = Helpers;
		const {getHashParams, setHashParams} = UI;
		const isEqual = (x, y) => {
			// test for equivalence of all properties of x and y
			for (const [p, v] of iterable(x))
			{
				if (y && y[p] != v) {return false;}
			}
			// test for properties in y missing from x, discounting any values that are explicitly or implicitly undefined
			for (const [p, v] of iterable(y))
			{
				if (isUndefined(x[p]) && !isUndefined(v)) {return false;}
			}
			return true;
		};
		const oldState = getHashParams();
		const replace = isEqual(oldState, state);
		return setHashParams(state, replace);
	}
	static replaceHashHistory(state)
	{
		return UI.setHashParams(state, true);
	}
	static getElement(name)
	{
		return document.getElementById(name);
	}
	static getChildren(node)
	{
		return node.children;
	}
	static find(node, selector)
	{
		return node.querySelector(selector);
	}
	static findAll(node, selector)
	{
		return node.querySelectorAll(selector) || [];
	}
	static closest(node, selector)
	{
		return node?.closest?.(selector);
	}
	static createElement(html)
	{
		const template = document.createElement('template');
		template.innerHTML = html.trim();
		return template.content.firstChild;
	}
	static empty(node)
	{
		while (node.firstChild) {node.removeChild(node.firstChild);}
		return node;
	}
	static center(node)
	{
		const center = () => {
			const {scrollHeight, clientHeight, scrollWidth, clientWidth} = node;
			node.scrollTop = (scrollHeight - clientHeight) / 2;
			node.scrollLeft = (scrollWidth - clientWidth) / 2;
		};
		setTimeout(center, 100);
		return node;
	}
	static getOffset(node)
	{
		return node.getBoundingClientRect();
	}
	static triggerChange(node)
	{
		node.dispatchEvent(new Event('change', {bubbles:true}));
		return node;
	}
	static hasClass(node, className)
	{
		return node && node.classList.contains(className);
	}
	static toggleClass(node, classList, enable = true)
	{
		const classes = classList.split(' ');
		node && node.classList[enable ? 'add' : 'remove'](...classes);
		return node;
	}
	static toggleFlow(node, show = true)
	{
		UI.toggleClass(node, 'noflow', !show);
		return node;
	}
	static toggleVisibility(node, show = true)
	{
		UI.toggleClass(node, 'hidden', !show);
		return node;
	}
	static toggleSelected(node, select = true)
	{
		UI.toggleClass(node, 'selected', select);
		return node;
	}
	static toggleDisabled(node, disable = true)
	{
		node.disabled = disable;
		return node;
	}
	static toggleChecked(node, check = true)
	{
		node.checked = check;
		return node;
	}
	static toggleReadOnly(node, readOnly = false)
	{
		node.readOnly = readOnly;
	}
	static setTitle(node, title)
	{
		node.title = title;
		return node;
	}
	static setValue(node, value)
	{
		node.value = value;
		return node;
	}
	static setDefaultValue(node, value)
	{
		if (node.type === 'checkbox') {node.defaultChecked = !!value;}
		else {node.defaultValue = value;}
		return node;
	}
	static setTabIndex(node, value)
	{
		node.tabIndex = value;
		return node;
	}
	static getDefaultValue(node)
	{
		return (node.type === 'checkbox') ? node.defaultChecked : node.defaultValue;
	}
	static setText(node, text)
	{
		node.textContent = text;
		return node;
	}
	static setHTML(node, html)
	{
		node.innerHTML = html;
		return node;
	}
	static getHTML(node)
	{
		return node.innerHTML;
	}
	static setData(node, data)
	{
		const {assign} = Helpers;
		assign(data).to(node.dataset);
		return node;
	}
	static getData(node)
	{
		return node.dataset;
	}
	static setSource(node, source)
	{
		node.src = source;
		return node;
	}
	static getSource(node)
	{
		return node.src;
	}
	static getViewportSize()
	{
		return {width: window.innerWidth, height: window.innerHeight};
	}
	static setList(formName, fieldName, value)
	{
		const form = document[formName];
		const field = form && form[fieldName];
		if (field) {field.setAttribute('list', value);}
	}
	static isVisible(node)
	{
		const {notEqual} = Helpers;
		const hasSize = Boolean(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
		const notHidden = notEqual(window.getComputedStyle(node).visibility, 'hidden');
		if (hasSize && notHidden) return true;
		// Special case for Bootstrap dropdown items - they can be functionally clickable
		// even when closed (offsetWidth/Height = 0) if they're not visibility:hidden
		if (node && node.classList && node.classList.contains('dropdown-item')) {
			const dropdown = node.closest('.dropdown-menu');
			if (dropdown) {return notHidden;}
		}
		return false;
	}
	static append(node, parent)
	{
		parent.appendChild(node);
		return parent;
	}
	static appendTo(parent, node)
	{
		parent.appendChild(node);
		return node;
	}
	static before(sibling, node)
	{
		sibling.before(node);
		return node;
	}
	static after(sibling, node)
	{
		sibling.after(node);
		return node;
	}
	static parent(node)
	{
		return node.parentNode;
	}
	static remove(node)
	{
		UI.parent(node).removeChild(node);
	}
	static focus(node, value)
	{
		value ? node.focus(value) : node.focus();
		return node;
	}
	static blur(node)
	{
		node.blur();
		return node;
	}
	static click(node)
	{
		node && node.click();
	}
	static checkButton(node, check)
	{
		UI.toggleChecked(node, check);
		UI.triggerChange(node);
		return node;
	}
	static getText(node)
	{
		return node.textContent || node.innerText;
	}
	static isDisabled(node)
	{
		return node.disabled;
	}
	static isChecked(node)
	{
		return node.checked;
	}
	static captureString(node)
	{
		return node.value.trim();
	}
	static captureInt(node)
	{
		return +node.value;
	}
	static consumeEvent(event)
	{
		if (event)
		{
			event.preventDefault();
			event.stopPropagation();
		}
		return event;
	}
	static nowrap(str)
	{
		return str.replace(' ', '&nbsp;');
	}
	static time()
	{
		return new Date(Date.now()).toLocaleString('en-US', {day:'numeric', month:'numeric', year:'numeric', hour:'numeric', minute:'numeric', seconds:'numeric'});
	}
	static download(name, content, type = 'text/plain')
	{
		const a = document.createElement('a');
		const url = URL.createObjectURL(new Blob([content], {type}));
		const destroy = () => {
			URL.revokeObjectURL(url);
			a.remove();
		};
		a.href = url;
		a.target = '_blank';
		a.download = name;
		a.onclick = () => setTimeout(destroy, 150);
		a.click();
		return a;
	}
	static captureFormData(formName)
	{
		const {isString} = Helpers;
		const form = isString(formName) ? document[formName] : formName;
		const rawData = new FormData(form);
		return Object.fromEntries(rawData);
	}
	constructor() {}
}
class Prefs // eslint-disable-line
{
	_initialized = false;
	toJSON() {return this.prefs;}
	refresh() { if (this._initialized) { this._refresh?.(); } }
	constructor(elements, prefs, refresh) {
		const {assign} = Helpers;
		this.elements = elements;
		this._refresh = refresh;
		assign(prefs).to(this);
		this._initialized = true;
	}
}
class Menu // eslint-disable-line
{
	set button(button) {this._button = button;}
	get button() {return this._button;}
	set node(node)
	{
		this._node = node;
		const ESCAPE = 27;
		const trapFocus = (event = {}) => {
			const {key, charCode, keyCode} = event;
			const code = charCode || keyCode;
			const escapeKey = (key === 'Escape' || code === ESCAPE);
			escapeKey && this.blur();
		};
		node.addEventListener('keydown', trapFocus, {passive:false});
	}
	get node() {return this._node;}
	set visible(visible)
	{
		this._visible = visible;
		this._node && UI.toggleVisibility(this._node, visible);
		visible && UI.focus(this.node);
	}
	get visible() {return this._visible;}
	focus() {this.visible = true;}
	blur() {this.visible = false;}
	click() {this.visible ^= 1;}
	constructor(name, menu, button)
	{
		this.visible = false;
		this.name = name;
		this.node = menu;
		this.button = button;
	}
}
class Panel
{
	// memorize current panel state
	set path(path)
	{
		const {isObject} = Helpers;
		if (isObject(path)) {this._path = path;}
	}
	// recall stored panel state
	get path()
	{
		return this._path;
	}
	set onStateChange(callback)
	{
		const {isFunction} = Helpers;
		if (isFunction(callback)) {this._triggerstatechange = callback;}
	}
	get onStateChange()
	{
		const passthrough = () => this.path;
		return this._triggerstatechange || passthrough;
	}
	set onVisibilityChange(callback)
	{
		const {isFunction} = Helpers;
		if (isFunction(callback)) {this._triggervisibilitychange = callback;}
	}
	get onVisibilityChange()
	{
		const noop = () => {};
		return this._triggervisibilitychange || noop;
	}
	get isVisible() {return this._visible || false;}
	set isVisible(visible) {this._visible = visible;}
	get isRendered() {return this._is_rendered || false;}
	set isRendered(isRendered) {this._is_rendered = isRendered;}
	async render(path)
	{
		this.isRendered = true;
		this.path = await this.onStateChange(path);
	}
	focus()
	{
		if (!this.isVisible) {this.onVisibilityChange(true);}
		this.isVisible = true;
	}
	blur()
	{
		if (this.isVisible) {this.onVisibilityChange(false);}
		this.isVisible = false;
		this.isRendered = false;
	}
	constructor(name, onStateChange, onVisibilityChange)
	{
		this.name = name;
		this.onStateChange = onStateChange;
		this.onVisibilityChange = onVisibilityChange;
	}
}
class MutexTabGroup // eslint-disable-line
{
	set keys(keys)
	{
		this._keys = keys;
	}
	get keys()
	{
		return this._keys || [];
	}
	set buttons(buttons)
	{
		this._buttons = buttons;
	}
	get buttons()
	{
		return this._buttons || [];
	}
	set tabs(tabs)
	{
		this._tabs = tabs;
	}
	get tabs()
	{
		return this._tabs || [];
	}
	set value(key)
	{
		const isVisible = (element, partiallyVisible = false) => {
			if (element)
			{
				const {top, left, bottom, right} = element.getBoundingClientRect();
				const {innerHeight, innerWidth} = window;
				return partiallyVisible
					? ((top > 0 && top < innerHeight) ||
						(bottom > 0 && bottom < innerHeight)) &&
						((left > 0 && left < innerWidth) || (right > 0 && right < innerWidth))
					: top >= 0 && left >= 0 && bottom <= innerHeight && right <= innerWidth;
			}
			return false;
		};
		if (key)
		{
			this._index = this.indexOf(key);
			if (this._index + 1)
			{
				const extent = this.buttons.length;
				for (let i = 0; i < extent; i++)
				{
					const button = this.buttons[i];
					if (button) {
						const selected = i === this._index;
						UI.toggleClass(button, 'active', selected);
						selected && !isVisible(button) && button.scrollIntoView();
					}
				}
			}
		}
	}
	get value()
	{
		return this.keys[this._index] || null;
	}
	indexOf(key)
	{
		return this.keys.indexOf(key);
	}
	lookup(key)
	{
		return this.tabs[this.indexOf(key)] || null;
	}
	constructor(tabs, focused)
	{
		const {isArray, arrayColumn} = Helpers;
		if (isArray(tabs))
		{
			this.tabs = tabs;
			this.keys = arrayColumn(tabs, 'key');
			this.buttons = arrayColumn(tabs, 'button');
			this.value = focused;
		}
	}
}
class MutexPanelGroup // eslint-disable-line
{
	get value()
	{
		return this._panel?.name || this.default;
	}
	get path()
	{
		return this._panel?.path || {[this.key]:this.value};
	}
	set path(path)
	{
		if (this._panel) {this.panel.path = path;}
	}
	get panel()
	{
		return this._panel || null;
	}
	// overloaded setter accepts panel objects, path objects and strings
	set panel(panel)
	{
		const {isObject, isEqual} = Helpers;
		const findPanel = () => {
			const {[this.key]:value} = panel;
			if (!value) {return this.default;}
			const index = this.indexOf(value);
			return this.panels[index];
		};
		if (panel && isObject(panel))
		{
			// all other cases eventually recurse to this point
			if (panel instanceof Panel)
			{
				this._panel = panel;
				for (const panel of this.panels)
				{
					// change visibility
					isEqual(panel.name, this.value) ? panel.focus() : panel.blur();
				}
			}
			else
			{
				const panel = findPanel();
				if (panel) {this.panel = panel;}
			}
		}
		// path is a string or is falsy
		else
		{
			const path = panel || this.default;
			this.panel = {[this.key]:path};
		}
	}
	indexOf(value)
	{
		let index = this.panels.length;
		while (index > 0)
		{
			index --;
			const panel = this.panels[index];
			if (panel.name === value) {return index;}
		}
		return null;
	}
	state(value)
	{
		const path = [].concat(value);
		let panel = this.panels[this.indexOf(path.shift()) || 0];
		return (path.length > 0) ? panel.state?.(path) : panel.path;
	}
	select(value)
	{
		this.render(this.state(value));
	}
	focus(value)
	{
		const panel = this.panels[this.indexOf(value)];
		if (!panel) {throw new Error(`${value} panel not found`);}
		panel.focus();
	}
	/*
		Leave path undefined to render the current path
		Specify a path object to render a new path
		If the panel is not specified in the path then the current panel will be used
	*/
	async render(path)
	{
		const {isObject, isEmpty} = Helpers;
		if (path && isObject(path))
		{
			// capture panel portion of path
			const {[this.key]:panel, ...rest} = path;
			// select specified panel or fallback to current panel or default
			this.panel = panel ? panel : this.value;
			// select specified path or fallback to current path
			if (isEmpty(rest)) {path = this.path;}
		}
		if (this.panel)
		{
			// preload the path then render as if doing a recall
			if (path) {this.path = path;}
			await this.panel.render(this.path);
		}
		return {[this.key]:this.value, ...this.path};
	}
	constructor(panels, key, defaultPanel, onStateChange)
	{
		const [firstPanel] = panels;
		this.panels = panels;
		this.key = key;
		this.default = defaultPanel || firstPanel.name;
		this.onStateChange = onStateChange;
	}
}
