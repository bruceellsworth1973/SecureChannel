/* global Helpers, UI, bootstrap, AsyncSemaphore */
class BusyQueue
{
	onChange()
	{
		const {isFunction} = Helpers;
		isFunction(this._onChange) && this._onChange(this._stack.length);
	}
	push(value)
	{
		this._stack.push(value);
		this.onChange();
	}
	pop()
	{
		const value = this._stack.pop();
		this.onChange();
		return value;
	}
	erase()
	{
		this._stack.length = 0;
		this.onChange();
	}
	constructor(onChange)
	{
		this._stack = [];
		this._onChange = onChange;
		this.onChange();
	}
}
class App extends UI //eslint-disable-line
{
	_randomString = '&RANDOMSTRING&'
	static async getJSON(source)
	{
		const response = await fetch(`json/${source}.json`);
		return await response.json();
	}
	static listOptions(value)
	{
		return value ? `
		<option value="${value}">` : '';
	}
	ifConfirmed (onConfirmed, onCanceled)
	{
		const {branch} = Helpers;
		return branch(onConfirmed, onCanceled);
	}
	get Initialized() {return this._ready_semaphore.hasOpened;}
	get isReady() {return this._ready_semaphore.isOpen;}
	set Ready(ready) {this._ready_semaphore.status = ready;}
	get Ready() {return this._ready_semaphore.status;}
	set UserResponse(result)
	{
		const response = this.responseStack.pop();
		// resolve queued promise
		response?.(result);
	}
	get UserResponse()
	{
		// queue a response promise
		return new Promise(response => this.responseStack.push(response));
	}
	set SessionID(sessionid)
	{
		this._sessionid = sessionid;
		// publish session value to websocket layer
		const {setSessionID} = this.exports;
		if (sessionid && setSessionID) {setSessionID(sessionid);}
	}
	get SessionID()
	{
		return this._sessionid || null;
	}
	get spinner()
	{
		return this._is_spinning || false;
	}
	set spinner(spinning)
	{
		const {getElement} = UI;
		this._is_spinning = !!spinning;
		const spinner = getElement('spinner');
		const toggleBusy = busy => busy ? this.busy++ : this.busy--;
		toggleBusy(this._is_spinning);
		this._is_spinning ? this.flow(spinner) : setTimeout(() => this.none(spinner), 1000) ;
	}
	get busy()
	{
		return this._is_busy || 0;
	}
	set busy(busy = 1)
	{
		const {getElement, toggleVisibility} = UI;
		this._is_busy = busy;
		const isVisible = busy > 0;
		const root = getElement('busy');
		// setTimeout required in case too many changes are thrown at the browser simultaneously
		setTimeout(() => toggleVisibility(root, isVisible), 0);
	}
	get elements() {return this.app?.elements || this._elements || (this._elements = {});}
	set elements(elements) {
		const {assign} = Helpers;
		assign(elements).to(this.elements);
		this.app && (this.app.elements = this.elements);
	}
	get exports() {return this._exports || (this._exports = {});}
	set exports(exports) {
		const {assign} = Helpers;
		assign(exports).to(this.exports);
		this.app && (this.app.exports = exports);
	}
	showToast(message, type, delay = 5) {
		const {getElement, createElement} = UI;
		const {Toast} = bootstrap;
		const toastId = Date.now();
		const colors = {
			info: 'bg-info',
			success: 'bg-success',
			warning: 'bg-warning',
			danger: 'bg-danger'
		};
		const symbols = {
			info: 'fa-info-circle',
			success: 'fa-check-circle',
			warning: 'fa-exclamation-triangle',
			danger: 'fa-times-circle'
		};
		const toastHTML = `
			<div id="toast-${toastId}" class="toast align-items-center text-white ${colors[type] || 'bg-danger'}" role="alert" aria-live="assertive" aria-atomic="true">
				<div class="d-flex">
					<div class="toast-body">
						<i class="fas ${symbols[type] || 'fa-times-circle'} me-2"></i>
						${message}
					</div>
					<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
				</div>
			</div>`;
		const toastElement = createElement(toastHTML);
		getElement('toast-container').appendChild(toastElement);
		const options = delay > 0 ? {autohide: true, delay: delay * 1000} : {autohide: false};
		const removeToast = () => toastElement.remove();
		const toast = new Toast(toastElement, options).show();
		toastElement.addEventListener('hidden.bs.toast', removeToast);
		return toast;
	}
	renderPanel = path => this.Panel = path
	setTitle = title => window.document.title = title
	alert = (title, message, onClose = () => {}) => {
		const {find, setHTML, trapFocus} = UI;
		const {alertDialog} = this.elements;
		const {focusForm, removeTrap} = trapFocus(alertDialog);
		const settle = result => {
			removeTrap && removeTrap();
			onClose();
			return result;
		};
		if (!message)
		{
			message = title;
			title = 'Alert';
		}
		// set user response handler
		this.exports.alertClose = () => {
			this.none(alertDialog);
			// settles the queued promise object
			this.UserResponse = true;
		};
		setHTML(find(alertDialog, '.dialog-title'), title);
		setHTML(find(alertDialog, '.dialog-message'), message);
		this.flow(alertDialog);
		// gets a new promise object that will be settled by user interaction
		const response = this.UserResponse.then(settle);
		// keybinds for the current dialog must be set after the UserResponse promise is queued
		// this allows previous keybinds to be restored after the promise resolves
		focusForm && focusForm();
		return response;
	}
	confirm = (title, message, onClose = () => {}) => {
		const {confirmDialog} = this.elements;
		const {isEqual} = Helpers;
		const {find, setHTML, trapFocus} = UI;
		const {focusForm, removeTrap} = trapFocus(confirmDialog);
		const settle = result => {
			removeTrap && removeTrap();
			onClose();
			return result;
		};
		// set user response handler
		this.exports.confirmClose = ({response}) => {
			this.none(confirmDialog);
			// settles the queued promise object
			this.UserResponse = isEqual(response, 'ok');
		};
		setHTML(find(confirmDialog, '.dialog-title'), title);
		setHTML(find(confirmDialog, '.dialog-message'), message);
		this.flow(confirmDialog);
		// gets a new promise object that will be settled by user interaction
		const response = this.UserResponse.then(settle);
		// keybinds for the current dialog must be set after the UserResponse promise is queued
		// this allows previous keybinds to be restored after the promise resolves
		focusForm && focusForm();
		return response;
	}
	onConfirmed = (title, message, onClose) => {
		const {branch} = Helpers;
		const then = (confirm, abort) => this.confirm(title, message, onClose).then(branch(confirm, abort));
		return {then};
	}
	onReady(fn)
	{
		const {isFunction} = Helpers;
		return isFunction(fn) && this.Ready.then(fn);
	}
	captureDateTime(node)
	{
		return new Date(UI.captureString(UI.find(node, 'input[type=date]')) + 'T' + UI.captureString(UI.find(node, 'input[type=time]')));
	}
	extractSetting(search)
	{
		const {isEqual, iterable, VALUES} = Helpers;
		for (const {setting_name, setting_value} of iterable(this.Settings, VALUES))
		{
			if (isEqual(setting_name, search)) {return setting_value;}
		}
		return null;
	}
	formatDateTime(moment, showToday = true, showWeekday = true)
	{
		const {today} = Helpers;
		const dateFmt = showWeekday ? {weekday:'long', year:'numeric', month:'long', day:'numeric'} : {year:'numeric', month:'long', day:'numeric'};
		const timeFmt = {hour:'numeric', minute:'numeric'};
		const isToday = today(moment);
		const date = showToday && isToday ? 'Today' : new Intl.DateTimeFormat('en-US', dateFmt).format(moment);
		const time = new Intl.DateTimeFormat('en-US', timeFmt).format(moment);
		return `${UI.nowrap(date)} ${UI.nowrap(`at ${time}`)}`;
	}
	displayClock()
	{
		const e_dateTime = UI.getElement('date-time');
		if (e_dateTime)
		{
			const tick = () => UI.setHTML(e_dateTime, UI.time().replace(',', '<br>'));
			tick();
			return setInterval(tick, 1000);
		}
	}
	onFormInput(target)
	{
		const {find, closest, toggleDisabled} = UI;
		const element = closest(target, 'form');
		if (element)
		{
			const {name} = element;
			const modified = this.isFormModified(name);
			const buttons = [
				find(element, 'button[type="submit"]'),
				find(element, 'button[type="reset"]')
			];
			const changeState = button => button && toggleDisabled(button, !modified);
			buttons.forEach(changeState);
		}
	}
	resetForm(formName, properties)
	{
		const {captureFormData} = UI;
		const {isString, iterable, KEYS} = Helpers;
		const form = isString(formName) ? document[formName] : formName;
		if (form)
		{
			if (!properties) {properties = captureFormData(formName);}
			const fields = iterable(properties, KEYS);
			for (const field of fields)
			{
				const element = form[field];
				// setTimeout fixes Chrome sometimes not reflecting the change
				if (element.type === 'checkbox') {setTimeout(() => element.checked = element.defaultChecked, 0);}
				else {element.value = element.defaultValue;}
			}
			this.onFormInput(form);
		}
	}
	isFormModified(formName)
	{
		const {captureFormData} = UI;
		const {iterable} = Helpers;
		const data = captureFormData(formName);
		const form = document.forms[formName];
		if (form && data)
		{
			for (const [field, value] of iterable(data))
			{
				if (form[field].defaultValue != value) {return true;}
			}
			return false;
		}
		return undefined;
	}
	lockRecord(table, key_value, lock = true)
	{
		const tables = {
			users:{table_name:'users', primary_key:'user_id', key_value}
		};
		const {reject} = Helpers;
		const {lockRecord, unlockRecord} = this.exports;
		const method = lock ? lockRecord : unlockRecord;
		const values = tables[table];
		if (values) {return method({values});}
		return reject(`invalid table: ${table}`);
	}
	async exception(event)
	{
		// this method is triggered by the backend to report underlying issues
		if (event) {console.error(event);}
	}
	clearValue(node) {UI.setValue(node, '');}
	hide(node) {return UI.toggleVisibility(node, false);}
	show(node) {return UI.toggleVisibility(node, true);}
	none(node) {return UI.toggleFlow(node, false);}
	flow(node) {return UI.toggleFlow(node, true);}
	hideAll(nodes) {nodes.forEach(this.hide);}
	showAll(nodes) {nodes.forEach(this.show);}
	closeAllModals()
	{
		const {getElement, findAll} = UI;
		const root = getElement('busy');
		findAll(root, 'div>section').forEach(this.none);
	}
	hideHeaderButtons()
	{
		const {findAll} = UI;
		const buttons = findAll(document, 'header button');
		this.hideAll(buttons);
	}
	showHeaderButtons()
	{
		const {findAll} = UI;
		const buttons = findAll(document, 'header button');
		this.showAll(buttons);
	}
	abortModalDialogs()
	{
		this.responseStack.erase();
		this.closeAllModals();
	}
	runSafely(fn)
	{
		return fn?.();
	}
	constructor(app)
	{
		super();
		this.app = app;
		const {getElement, consumeEvent, closest, isVisible, getData} = UI;
		const {iterable} = Helpers;
		// main UI element lookup table (cached for speed and maintainablility)
		this.elements = {
			loading:getElement('loading'),
			spinner:getElement('spinner'),
			unauthDialog:getElement('unauthorized'),
			loginDialog:getElement('login'),
			alertDialog:getElement('alert'),
			confirmDialog:getElement('confirm'),
			userButton:getElement('user')
		};
		// bind real-time clock display
		this.displayClock();
		const triggerAction = (event, source, type, block = true) => {
			if (type === 'deselect') {this.exports.deselect?.call(source, {}, event);}
			else if (source && isVisible(source)) {
				const {[type]:action, ...data} = getData(source);
				const method = action && this.exports[action];
				if (method) {
					block && consumeEvent(event);
					method.call(source, data, event);
					return true;
				}
			}
			return false;
		};
		// bind handlers to user events
		const handlers = {
			dblclick:event => {
				const {target} = event;
				const source = closest(target, ['[data-dblclick]']);
				triggerAction(event, source, 'dblclick');
			},
			click:event => {
				const {target} = event;
				// prioritize href over custom click event
				if (closest(target, ['[href']) || closest(target, ['input[type=checkbox]'])) {return;}
				const source = closest(target, ['[data-click]']);
				triggerAction(event, source, 'click') || triggerAction(event, target, 'deselect');
			},
			contextmenu:event => {
				const {target} = event;
				const source = closest(target, ['[data-context]']);
				triggerAction(event, source, 'context');
			},
			input:event => {
				const {target} = event;
				const source = closest(target, ['[data-input]']);
				triggerAction(event, source, 'input', false);
			},
			change:event => {
				const {target} = event;
				const source = closest(target, ['[data-change]']);
				triggerAction(event, source, 'change');
			},
			focus:event => {
				const {target} = event;
				const source = closest(target, ['[data-focus]']);
				triggerAction(event, source, 'focus');
			},
			blur:event => {
				const {target} = event;
				const source = closest(target, ['[data-blur]']);
				triggerAction(event, source, 'blur');
			},
			mouseover:event => {
				const {target} = event;
				const source = closest(target, ['[data-hover']);
				triggerAction(event, source, 'hover');
			},
			mouseout:event => {
				const {target} = event;
				const source = closest(target, ['[data-hover']);
				triggerAction(event, source, 'hover');
			},
			mousedown:event => {
				const {target} = event;
				const source = closest(target, ['[data-drag']);
				triggerAction(event, source, 'drag');
			},
			mouseup:event => {
				const {target} = event;
				const source = closest(target, ['[data-drag']);
				triggerAction(event, source, 'drag');
			},
			mousemove:event => {
				const {target} = event;
				// Check for both drag and generic mousemove handlers
				const dragSource = closest(target, ['[data-drag']);
				const moveSource = closest(target, ['[data-mousemove]']);
				if (dragSource) {
					triggerAction(event, dragSource, 'drag');
				}
				if (moveSource) {
					triggerAction(event, moveSource, 'mousemove', false);
				}
			},
			mouseleave:event => {
				const {target} = event;
				const source = closest(target, ['[data-drag']);
				triggerAction(event, source, 'drag');
			},
			submit:event => {
				const {target} = event;
				const source = closest(target, ['[data-submit]']);
				triggerAction(event, source, 'submit');
			},
			reset:event => {
				const {target} = event;
				const source = closest(target, ['[data-reset]']);
				triggerAction(event, source, 'reset');
			},
			scroll:event => {
				const {target} = event;
				const source = closest(target, ['[data-scroll]']);
				triggerAction(event, source, 'scroll');
			},
			wheel:event => {
				const {target} = event;
				const source = closest(target, ['[data-wheel]']);
				triggerAction(event, source, 'wheel');
			}
		};
		for (const [event, handler] of iterable(handlers)) {document.addEventListener(event, handler, {passive:false});}
		// Popstate fires on window, not document
		const onBusyChanged = length => this.busy = length;
		this.responseStack = new BusyQueue(onBusyChanged);
		this._ready_semaphore = new AsyncSemaphore(false);
	}
}
