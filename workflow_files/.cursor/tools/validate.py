#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
质量门禁脚本（漫剧剧本）

校验项（按数值质量合同 + 格式规则，可判定部分）：
  1. 每集汉字 700-1200
  2. ▲ 最多连续 2 段
  3. 同角色、中间无▲打断的连续台词必须合并为一行
  4. 单句台词不超过 100 字（按台词内容汉字计）
  5. 标题格式「第N集——第N章」
  6. 场景头格式「地点：xx，内/外，日/夜」与「人物：xx」
  7. 台词格式「角色名：内容」（内容非空）
  8. 结尾必须【卡黑】（作为最后一个非空内容行）

说明：
  - 只读校验，不修改任何文件。
  - 任一集任一规则不通过，该集判 FAIL；退出码 1 表示存在 FAIL。

用法：
  python .cursor/tools/validate.py [文件...]
  不带参数时默认校验项目根 scripts/Episode-*.md
"""

import re
import sys
from pathlib import Path

# 项目根目录：.cursor/tools/ 的上两级
ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT / 'scripts'

# 可调阈值
HAN_MIN = 700
HAN_MAX = 1200
MAX_CONSECUTIVE_ACTION = 2
MAX_LINE_LEN = 100


def count_han(text):
    return len(re.findall(r'[\u4e00-\u9fff]', text))


def is_title(s):
    return bool(re.match(r'^第\d+集——第\d+章$', s))


def is_scene_no(s):
    return bool(re.match(r'^\d+-\d+$', s))


def is_scene_header(s):
    return s.startswith('地点：') or s.startswith('人物：')


def is_dialogue(s):
    if not s:
        return False
    if s.startswith('▲') or s.startswith('【'):
        return False
    if is_title(s) or is_scene_no(s) or is_scene_header(s):
        return False
    return '：' in s


def speaker_of(s):
    return s.split('：', 1)[0]


def check(path):
    lines = open(path, encoding='utf-8').read().splitlines()
    issues = []
    text = '\n'.join(lines)

    # 1. 汉字数
    han = count_han(text)
    if not (HAN_MIN <= han <= HAN_MAX):
        issues.append('汉字数 {}（应为 {}-{}）'.format(han, HAN_MIN, HAN_MAX))

    # 2. ▲ 连续
    cnt = 0
    maxc = 0
    for l in lines:
        if l.strip().startswith('▲'):
            cnt += 1
            maxc = max(maxc, cnt)
        else:
            cnt = 0
    if maxc > MAX_CONSECUTIVE_ACTION:
        issues.append('▲ 最多连续 {} 段（应 ≤{}）'.format(maxc, MAX_CONSECUTIVE_ACTION))

    # 3. 同角色连续台词未合并
    nonempty = [(i, l.strip()) for i, l in enumerate(lines) if l.strip()]
    for k in range(len(nonempty) - 1):
        i1, a = nonempty[k]
        i2, b = nonempty[k + 1]
        if is_dialogue(a) and is_dialogue(b) and speaker_of(a) == speaker_of(b):
            issues.append('同角色连续台词未合并：第{}行与第{}行（"{}…"）'.format(i1 + 1, i2 + 1, a[:12]))

    # 4. 单句台词长度
    for i, l in enumerate(lines):
        s = l.strip()
        if is_dialogue(s):
            content = s.split('：', 1)[1]
            n = count_han(content)
            if n > MAX_LINE_LEN:
                issues.append('单句台词 {} 字（应 ≤{}）：第{}行 "{}…"' .format(n, MAX_LINE_LEN, i + 1, s[:15]))

    # 5. 标题
    if not any(is_title(l.strip()) for l in lines):
        issues.append('缺少标题「第N集——第N章」')

    # 6. 场景头
    if not any(is_scene_header(l.strip()) for l in lines):
        issues.append('缺少场景头「地点：…」/「人物：…」')

    # 7. 台词格式（内容非空）
    for i, l in enumerate(lines):
        s = l.strip()
        if is_dialogue(s):
            if not s.split('：', 1)[1].strip():
                issues.append('台词内容为空：第{}行'.format(i + 1))

    # 8. 结尾【卡黑】且作为最后一个非空内容行
    nonempty2 = [l.strip() for l in lines if l.strip()]
    if not nonempty2 or '【卡黑】' not in nonempty2[-1]:
        issues.append('结尾必须【卡黑】且作为最后一个非空内容行')

    return issues


def main():
    files = sys.argv[1:]
    if not files:
        files = sorted(SCRIPTS_DIR.glob('Episode-*.md'))
    if not files:
        print('未找到待校验文件')
        return 2

    all_ok = True
    for f in files:
        issues = check(f)
        if issues:
            all_ok = False
            print('FAIL {}'.format(f))
            for it in issues:
                print('    - {}'.format(it))
        else:
            print('PASS {}'.format(f))

    print()
    print('ALL PASS' if all_ok else 'EXISTS FAIL')
    return 0 if all_ok else 1


if __name__ == '__main__':
    sys.exit(main())
