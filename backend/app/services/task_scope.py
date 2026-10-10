"""本地整理的日期范围与用户指定目录校验。"""
from datetime import date
import calendar
import re
from pathlib import Path
from typing import Annotated

from fastapi import HTTPException
from pydantic import BaseModel, Field, model_validator

Month = Annotated[str, Field(pattern=r'^20\d{2}-(0[1-9]|1[0-2])$')]


def extract_dates(text, now):
    scope = {'month': None, 'months': [], 'date_from': None, 'date_to': None}
    exact = list(re.finditer(r'20\d{2}-\d{2}-\d{2}', text))
    if exact:
        if len(exact) != 2 or text[exact[0].end():exact[1].start()].strip() not in {'至', '到', '~', '～'}:
            raise ValueError('日期区间请写为 YYYY-MM-DD 至 YYYY-MM-DD')
        scope.update(date_from=date.fromisoformat(exact[0].group()).isoformat(), date_to=date.fromisoformat(exact[1].group()).isoformat())
        return text[:exact[0].start()] + text[exact[1].end():], TaskScope(**scope).model_dump(mode='json')
    tokens = list(re.finditer(r'(?:(20\d{2})[年/-])?(\d{1,2})月|(?P<iso>20\d{2}-\d{2})(?![-\d])', text))
    if tokens:
        year = now.year
        months = []
        for token in tokens:
            if token.group('iso'):
                year, mon = map(int, token.group('iso').split('-'))
            else:
                year = int(token.group(1)) if token.group(1) else year
                mon = int(token.group(2))
            if not 1 <= mon <= 12:
                raise ValueError('月份应在1至12之间')
            months.append(f'{year:04d}-{mon:02d}')
        gap = text[tokens[0].end():tokens[-1].start()].strip()
        if len(tokens) == 2 and gap in {'至', '到', '-', '~', '～'}:
            y, m = map(int, months[-1].split('-'))
            scope.update(date_from=months[0] + '-01', date_to=f'{months[-1]}-{calendar.monthrange(y, m)[1]:02d}')
        else:
            for left, right in zip(tokens, tokens[1:]):
                if text[left.end():right.start()].strip() not in {'、', ',', '，', '和', '及'}:
                    raise ValueError('多个开票月份请用顿号分隔')
            scope['month' if len(months) == 1 else 'months'] = months[0] if len(months) == 1 else months
        return text[:tokens[0].start()] + text[tokens[-1].end():], TaskScope(**scope).model_dump(mode='json')
    year_match = re.search(r'(20\d{2})年(?:全年|每个月|所有月份|全部月份)?', text)
    if year_match:
        year = year_match.group(1)
        scope.update(date_from=year+'-01-01', date_to=year+'-12-31')
        return text[:year_match.start()] + text[year_match.end():], scope
    for word in ['上个月', '上月', '这个月', '本月']:
        if word in text:
            mon = now.month - int(word in {'上个月', '上月'})
            year = now.year
            if mon == 0:
                year, mon = year - 1, 12
            scope['month'] = f'{year:04d}-{mon:02d}'
            return text.replace(word, '', 1), scope
    return text, scope


class TaskScope(BaseModel):
    month: Month | None = None
    months: list[Month] = Field(default_factory=list, max_length=120)
    date_from: date | None = None
    date_to: date | None = None
    source_dir: str | None = Field(default=None, max_length=1024, description='用户明确提供的绝对目录。未提供时询问位置，不得猜测。用户明确说素材目录时可使用应用素材目录。')

    @model_validator(mode='after')
    def validate_dates(self):
        if sum([bool(self.month), bool(self.months), bool(self.date_from or self.date_to)]) > 1:
            raise ValueError('单月、多个月份、日期区间只能选择一种')
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError('开始日期不能晚于结束日期')
        self.months = sorted(set(self.months))
        return self


def source_root(value):
    if not value or not str(value).strip():
        raise HTTPException(422, '请先说明发票所在的文件夹完整路径')
    path = Path(str(value).strip())
    if not path.is_absolute() or path == Path(path.anchor):
        raise HTTPException(422, '请指定具体文件夹的绝对路径，不能扫描整个磁盘')
    try:
        if not path.is_dir():
            raise HTTPException(422, '指定的发票文件夹不存在或无法访问，请核对位置')
        for part in [path, *path.parents]:
            if part.is_symlink() or getattr(part.lstat(), 'st_file_attributes', 0) & 0x400:
                raise HTTPException(422, '请提供实际文件夹路径，不使用符号链接或目录连接')
        return path.resolve()
    except OSError:
        raise HTTPException(422, '无法访问指定的发票文件夹')
