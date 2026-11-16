"""Tablet tool mapping and strict isolation from other desktop applications."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call

spec = importlib.util.spec_from_file_location('notesgood_pen', Path(__file__).resolve().parents[1] / 'scripts/notesgood-pen.py')
pen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pen)


class PenTests(unittest.TestCase):
    def setUp(self):
        self.hypr = Mock()
        self.hypr.active.return_value = '0x123'
        self.hypr.switch.return_value = '0x123'
        self.state = pen.PenState(self.hypr)

    def test_first_button_erases_then_returns_to_pen(self):
        for tool, kind in [('eraser', 'device'), ('eraser', 'motion'), ('stylus', 'device'), ('stylus', 'motion')]:
            self.state.handle(tool, kind)
        self.assertEqual(self.hypr.switch.call_args_list, [call('e', '0x123'), call('p', '0x123')])

    def test_second_button_lassos_and_keeps_selection_movable(self):
        for button in (2, 3):
            self.setUp()
            for kind, detail in [('press', button), ('press', 1), ('release', button), ('release', 1)]:
                self.state.handle('stylus', kind, detail)
            self.hypr.switch.assert_called_once_with('l', '0x123')
            for _ in range(4):
                self.state.handle('stylus', 'press', 1)
                self.state.handle('stylus', 'release', 1)
            self.hypr.switch.assert_called_once_with('l', '0x123')

    def test_lasso_can_be_reactivated_after_manually_switching_to_pen(self):
        for _ in range(2):
            self.state.handle('stylus', 'press', 2)
            self.state.handle('stylus', 'release', 2)
        self.assertEqual(self.hypr.switch.call_args_list, [call('l', '0x123'), call('l', '0x123')])

    def test_eraser_after_lasso_returns_to_pen_without_reactivating_lasso(self):
        self.state.handle('stylus', 'press', 2)
        self.state.handle('eraser', 'motion')
        self.state.handle('stylus', 'motion')
        self.assertEqual(self.hypr.switch.call_args_list, [call('l', '0x123'), call('e', '0x123'), call('p', '0x123')])

    def test_after_blank_tap_only_a_new_lasso_button_press_can_select_again(self):
        self.state.handle('stylus', 'press', 2)
        self.state.handle('stylus', 'release', 2)
        # The editor switches to pen when the user taps blank space.
        self.hypr.switch.reset_mock()
        for _ in range(3):
            for kind, detail in [('device', 0), ('motion', 0), ('press', 1), ('release', 1), ('release', 2)]:
                self.state.handle('stylus', kind, detail)
            self.state.reconcile()
        self.hypr.switch.assert_not_called()
        self.state.handle('eraser', 'device')
        self.state.handle('stylus', 'device')
        self.assertEqual(self.hypr.switch.call_args_list, [call('e', '0x123'), call('p', '0x123')])
        self.state.handle('stylus', 'press', 2)
        self.hypr.switch.assert_called_with('l', '0x123')

    def test_new_eraser_press_cancels_a_deferred_return_to_pen(self):
        self.state.pending['0x123'] = 'p'
        self.state.handle('eraser', 'motion')
        self.state.reconcile()
        self.hypr.switch.assert_called_once_with('e', '0x123')
        self.assertFalse(self.state.pending)

    def test_normal_motion_does_not_poll_the_compositor(self):
        for _ in range(100):
            self.state.reconcile()
            self.state.handle('stylus', 'motion')
        self.hypr.active.assert_not_called()

    def test_other_devices_and_plain_tip_do_not_change_tools(self):
        for tool, kind, detail in [(None, 'press', 2), ('keyboard', 'press', 2), ('stylus', 'key', 2), ('stylus', 'press', 1), ('stylus', 'release', 1)]:
            self.state.handle(tool, kind, detail)
        self.hypr.switch.assert_not_called()

    def test_press_outside_notesgood_is_ignored_and_eraser_works_on_enter(self):
        self.hypr.active.return_value = None
        self.state.handle('stylus', 'press', 2)
        self.state.handle('eraser', 'motion')
        self.hypr.switch.assert_not_called()
        self.hypr.active.return_value = '0x123'
        self.state.handle('eraser', 'motion')
        self.hypr.switch.assert_called_once_with('e', '0x123')

    def test_release_outside_restores_only_the_original_window(self):
        self.state.handle('eraser', 'motion')
        self.hypr.active.return_value = None
        self.hypr.switch.return_value = None
        self.state.handle('stylus', 'motion')
        self.hypr.active.return_value = '0x456'
        self.hypr.switch.reset_mock()
        self.state.reconcile()
        self.hypr.switch.assert_not_called()
        self.hypr.active.return_value = '0x123'
        self.hypr.switch.return_value = '0x123'
        self.state.reconcile()
        self.hypr.switch.assert_called_once_with('p', '0x123')

    def test_hyprland_checks_class_backend_and_target_before_sending(self):
        hypr = pen.Hyprland.__new__(pen.Hyprland)
        valid = {'class': 'notesgood', 'xwayland': True, 'address': '0x123'}
        import json
        for window in [valid, {**valid, 'class': 'fleet-goodnotes'}, {**valid, 'xwayland': False}, {**valid, 'address': 'invalid,exec'}]:
            hypr.request = Mock(return_value=json.dumps(window))
            self.assertEqual(hypr.active(), '0x123' if window == valid else None)
        hypr.active = Mock(side_effect=['0x123', '0x456'])
        hypr.request = Mock(return_value='ok')
        hypr.switch('e', '0x456')
        hypr.request.assert_not_called()
        hypr.active = Mock(return_value='0x123')
        self.assertEqual(hypr.switch('l', '0x123'), '0x123')
        hypr.request.assert_called_once_with('/dispatch sendshortcut CTRL ALT SHIFT, l, address:0x123')

    def test_only_tablet_stylus_and_eraser_are_subscribed(self):
        names = ['xwayland-tablet stylus:1', 'xwayland-tablet eraser:1', 'xwayland-pointer:1', 'keyboard', 'xwayland-tablet cursor:1']
        self.assertEqual(pen.pen_devices([SimpleNamespace(name=name, deviceid=i) for i, name in enumerate(names)]), {0: 'stylus', 1: 'eraser'})


if __name__ == '__main__':
    unittest.main()
