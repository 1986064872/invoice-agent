export function dateScopeText(scope: { month?: string | null; months?: string[]; date_from?: string | null; date_to?: string | null }) {
  if (scope.month) return scope.month
  if (scope.months?.length) return scope.months.join('、')
  if (scope.date_from || scope.date_to) return (scope.date_from || '不限起始') + ' 至 ' + (scope.date_to || '不限结束')
  return '不限日期'
}
