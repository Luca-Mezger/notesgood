#!/usr/bin/env python3
"""Bridge XWayland tablet eraser/side-button events to Notesgood on Hyprland.

Requires python-xlib. Reads tablet tool/button events only, never keyboard events
or coordinates. Does not change device mappings or other applications.
"""
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import sys


class Hyprland:
    def __init__(self):
        self.path = Path(os.environ['XDG_RUNTIME_DIR']) / 'hypr' / os.environ['HYPRLAND_INSTANCE_SIGNATURE'] / '.socket.sock'

    def request(self, command):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(0.5)
            connection.connect(str(self.path))
            connection.sendall(command.encode())
            chunks = []
            while block := connection.recv(65536):
                chunks.append(block)
            return b''.join(chunks).decode()

    def active(self):
        try:
            window = json.loads(self.request('j/activewindow'))
            address = window.get('address', '')
            if (window.get('class') == 'notesgood' and window.get('xwayland') is True
                    and re.fullmatch(r'0x[0-9a-fA-F]+', address)):
                return address
        except (OSError, ValueError, AttributeError, TypeError):
            pass
        return None

    def switch(self, key, expected=None):
        if key not in ('e', 'l', 'p'):
            raise ValueError('Unsupported pen tool')
        address = self.active()
        if not address or (expected is not None and expected != address):
            return None
        if self.request(f'/dispatch sendshortcut , {key}, address:{address}').strip() == 'ok':
            return address
        return None


class PenState:
    def __init__(self, hypr):
        self.hypr = hypr
        self.erasing = None
        self.tool = None
        self.selecting = None
        self.selection_button_down = False
        self.selection_move_started = False
        self.pending = {}

    def restore(self, address, key='p'):
        if address and not self.hypr.switch(key, address):
            self.pending[address] = key

    def reconcile(self):
        if not self.pending:
            return
        address = self.hypr.active()
        if address in self.pending and self.hypr.switch(self.pending[address], address):
            del self.pending[address]

    def handle(self, tool, kind, button=0):
        if tool not in ('stylus', 'eraser') or kind not in ('motion', 'press', 'release', 'device'):
            return
        if tool == 'eraser':
            if self.tool != tool or not self.erasing:
                address = self.hypr.active()
                if address:
                    self.erasing = self.hypr.switch('e', address)
                    if self.erasing:
                        self.pending.pop(address, None)
            self.tool = tool
            return
        self.tool = tool
        if self.erasing:
            self.restore(self.erasing, 'l' if self.selecting == self.erasing else 'p')
            self.erasing = None
        if button == 1:
            if kind == 'press' and self.selecting and not self.selection_button_down:
                self.selection_move_started = True
            elif kind == 'release' and self.selecting and self.selection_move_started:
                self.restore(self.selecting)
                self.selecting = None
                self.selection_move_started = False
            return
        if button not in (2, 3):
            return
        if kind == 'press':
            address = self.hypr.active()
            if not address:
                return
            if self.selecting != address:
                self.selecting = self.hypr.switch('l', address)
            if self.selecting:
                self.selection_button_down = True
                self.selection_move_started = False
        elif kind == 'release' and self.selecting:
            # Keep the selection movable after releasing the button. The next
            # pen gesture moves it, then returns to writing.
            self.selection_button_down = False

    def close(self):
        for address in {self.erasing, self.selecting} - {None}:
            self.hypr.switch('p', address)


def pen_devices(devices):
    return {device.deviceid: ('eraser' if 'eraser' in device.name else 'stylus')
            for device in devices
            if re.fullmatch(r'xwayland-tablet (stylus|eraser):\d+', device.name)}


def run():
    from Xlib import display
    from Xlib.ext import xinput
    from Xlib.protocol import rq

    kinds = {xinput.RawMotion: 'motion', xinput.RawButtonPress: 'press', xinput.RawButtonRelease: 'release'}
    mask = xinput.RawMotionMask | xinput.RawButtonPressMask | xinput.RawButtonReleaseMask
    # Decode only the XI2 header; ignore all valuator/position data.
    header = rq.Struct(rq.Card16('deviceid'), rq.Card32('time'), rq.Card32('detail'),
                       rq.Card16('sourceid'), rq.Card16('valuators_len'), rq.Card32('flags'), rq.Pad(4))
    connection = display.Display()
    state = PenState(Hyprland())
    running = True

    def stop(_signal, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        connection.xinput_query_version()
        opcode = connection.query_extension('XInputExtension').major_opcode
        for kind in kinds:
            connection.ge_add_event_data(opcode, kind, header)
        connection.ge_add_event_data(opcode, xinput.DeviceChanged, xinput.DeviceChangedEventData)
        root = connection.screen().root
        root.xinput_select_events([(xinput.AllDevices, xinput.HierarchyChangedMask)])

        def refresh():
            inventory = connection.xinput_query_device(xinput.AllDevices).devices
            devices = pen_devices(inventory)
            if devices:
                root.xinput_select_events([(device, mask) for device in devices])
            root.xinput_select_events([(device.deviceid, xinput.DeviceChangedMask)
                                       for device in inventory if device.use == xinput.MasterPointer])
            connection.flush()
            return devices

        devices = refresh()
        print('Notesgood pen bridge ready', flush=True)
        while running:
            state.reconcile()
            if not connection.pending_events() and not select.select([connection.fileno()], [], [], 0.25)[0]:
                continue
            event = connection.next_event()
            kind = getattr(event, 'evtype', None)
            if kind == xinput.HierarchyChanged:
                devices = refresh()
            elif kind in kinds:
                state.handle(devices.get(event.data.sourceid), kinds[kind], event.data.detail)
            elif kind == xinput.DeviceChanged:
                state.handle(devices.get(event.data.sourceid), 'device')
    finally:
        try:
            state.close()
        finally:
            connection.close()


if __name__ == '__main__':
    try:
        run()
    except (OSError, KeyError, ValueError, ImportError):
        print('Notesgood pen bridge: XWayland/Hyprland or python-xlib unavailable', file=sys.stderr)
        sys.exit(1)
