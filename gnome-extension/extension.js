import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const XML = `<node><interface name="org.bencut.Recorder">
  <method name="Ping"><arg type="s" direction="out"/></method>
  <method name="Prepare">
    <arg type="i" direction="in"/><arg type="i" direction="in"/>
    <arg type="i" direction="in"/><arg type="i" direction="in"/>
    <arg type="s" direction="out"/>
  </method>
  <method name="Begin"><arg type="s" direction="out"/></method>
  <method name="PrepareLayer"><arg type="s" direction="out"/></method>
  <method name="Snapshot"><arg type="s" direction="out"/></method>
  <method name="Finish"><arg type="s" direction="out"/></method>
</interface></node>`;

export default class BenCutRecorder extends Extension {
  enable() {
    this._tabAction = null;
    this._tabSignal = null;
    this._frame = null;
    this._session = null;
    this._layerTimer = null;
    this._exported = Gio.DBusExportedObject.wrapJSObject(XML, this);
    this._exported.export(Gio.DBus.session, '/org/bencut/Recorder');
  }

  Ping() { return '2'; }

  PrepareLayer() {
    if (this._tabAction !== null || this._layerTimer) throw new Error('O BenCut já está gravando.');
    const m = Main.layoutManager.primaryMonitor;
    if (!m || m.width < 540 || m.height < 960)
      throw new Error('O recorte central 540 × 960 não cabe neste monitor.');
    this.Prepare(m.x + Math.floor((m.width - 540) / 2),
      m.y + Math.floor((m.height - 960) / 2), 540, 960);
    this._session.mode = 'cursor-layer';
    this._session.events = [this._layerPosition(0)];
    return this.Snapshot();
  }

  _layerPosition(t) {
    const [mx, my] = global.get_pointer();
    const {monitor: m, area: a} = this._session;
    const onMonitor = mx >= m.x && mx < m.x + m.width && my >= m.y && my < m.y + m.height;
    const inside = mx >= a.x && mx < a.x + a.width && my >= a.y && my < a.y + a.height;
    return {t, visible: onMonitor && !inside,
      x: Math.round(Math.max(m.x, Math.min(mx - a.width / 2, m.x + m.width - a.width))),
      y: Math.round(Math.max(m.y, Math.min(my - a.height / 4, m.y + m.height - a.height / 2)))};
  }

  Prepare(x, y, width, height) {
    if (this._tabAction !== null || this._layerTimer) throw new Error('O BenCut já está gravando.');
    const monitor = Main.layoutManager.monitors.find(m =>
      x + width / 2 >= m.x && x + width / 2 < m.x + m.width &&
      y + height / 2 >= m.y && y + height / 2 < m.y + m.height);
    if (!monitor || width < 2 || height < 2 || width > monitor.width || height > monitor.height)
      throw new Error('Selecione o recorte dentro de um único monitor.');
    x = Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - width));
    y = Math.max(monitor.y, Math.min(y, monitor.y + monitor.height - height));
    this._session = {
      version: 1,
      monitor: {x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height},
      area: {x, y, width, height},
      events: [{t: 0, x, y}],
    };
    return JSON.stringify(this._session);
  }

  Begin() {
    if (!this._session || this._tabAction !== null || this._layerTimer) throw new Error('Gravação não preparada.');
    this._started = GLib.get_monotonic_time();
    if (this._session.mode === 'cursor-layer') {
      this._session.events = [this._layerPosition(0)];
      this._layerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        const e = this._layerPosition((GLib.get_monotonic_time() - this._started) / 1e6);
        const events = this._session.events;
        const last = events[events.length - 1];
        if (e.visible !== last.visible || (e.visible && (e.x !== last.x || e.y !== last.y))) events.push(e);
        return GLib.SOURCE_CONTINUE;
      });
      // Apenas o contorno externo: nenhuma linha ou prévia cobre a captura.
      this._frame = new St.Widget({reactive: false, can_focus: false,
        style: 'border: 2px solid #9b5cf0; background-color: transparent;'});
      Main.layoutManager.addTopChrome(this._frame);
      this._placeFrame();
      return this.Snapshot();
    }
    this._tabAction = global.display.grab_accelerator('Tab', Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
    if (this._tabAction === Meta.KeyBindingAction.NONE) {
      this._tabAction = null;
      throw new Error('Não foi possível reservar Tab para a gravação.');
    }
    Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._tabAction), Shell.ActionMode.NORMAL);
    // A borda fica fora do recorte e não recebe cliques nem foco.
    this._frame = new St.Widget({reactive: false, can_focus: false,
      style: 'border: 2px solid #9b5cf0; background-color: transparent;'});
    Main.layoutManager.addTopChrome(this._frame);
    this._placeFrame();
    this._tabSignal = global.display.connect('accelerator-activated', (_display, action) => {
      if (action !== this._tabAction) return;
      const [mouseX, mouseY] = global.get_pointer();
      const {monitor: m, area: a, events} = this._session;
      const now = (GLib.get_monotonic_time() - this._started) / 1e6;
      if (mouseX >= m.x && mouseX < m.x + m.width &&
          mouseY >= m.y && mouseY < m.y + m.height) {
        const zone = Math.min(3, Math.floor((mouseX - m.x) * 4 / m.width));
        const target = m.x + (zone + 0.5) * m.width / 4 - a.width / 2;
        const x = Math.round(Math.max(m.x, Math.min(target, m.x + m.width - a.width)));
        if (x !== a.x) {
          a.x = x;
          this._placeFrame();
          events.push({t: now, x, y: a.y});
        }
      }
    });
    return JSON.stringify(this._session);
  }

  _placeFrame() {
    const a = this._session.area;
    this._frame.set_position(a.x - 2, a.y - 2);
    this._frame.set_size(a.width + 4, a.height + 4);
  }

  Snapshot() { return JSON.stringify(this._session); }

  Finish() {
    if (this._layerTimer) GLib.source_remove(this._layerTimer);
    this._layerTimer = null;
    if (this._tabSignal) global.display.disconnect(this._tabSignal);
    this._tabSignal = null;
    if (this._tabAction !== null) {
      Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._tabAction), Shell.ActionMode.NONE);
      global.display.ungrab_accelerator(this._tabAction);
    }
    this._tabAction = null;
    this._frame?.destroy();
    this._frame = null;
    return this.Snapshot();
  }

  disable() {
    this.Finish();
    this._exported?.unexport();
    this._exported = null;
    this._session = null;
  }
}
