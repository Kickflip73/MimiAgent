import sys
import unittest
from chattts_safety import validate_text, supervise


class SafetyTests(unittest.TestCase):
    def test_text_limit(self):
        validate_text('中' * 300)
        for text in ['中' * 301, 'a' * 301, '😀' * 151]:
            with self.assertRaises(ValueError):
                validate_text(text)

    def test_short_process(self):
        self.assertEqual(supervise([sys.executable, '-c', 'pass']), 0)

    def test_memory_limit_stops_process(self):
        with self.assertRaisesRegex(RuntimeError, 'memory budget'):
            supervise([sys.executable, '-c', 'import time; time.sleep(60)'], memory_reader=lambda _: 500, max_rss=100)

    def test_deadline_stops_process(self):
        with self.assertRaisesRegex(RuntimeError, 'lifetime'):
            supervise([sys.executable, '-c', 'import time; time.sleep(60)'], max_seconds=0)

    def test_failed_measurement_stops_process(self):
        def unavailable(_):
            raise RuntimeError('Cannot verify')
        with self.assertRaisesRegex(RuntimeError, 'Cannot verify'):
            supervise([sys.executable, '-c', 'import time; time.sleep(60)'], memory_reader=unavailable)


if __name__ == '__main__':
    unittest.main()
