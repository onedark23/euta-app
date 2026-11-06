// "저장하지 않은 변경" guard (SPEC 스크립트-보기-편집): the script editor marks itself dirty; leaving
// the detail screen or switching project / app view asks first.
let dirty = false;

export function setUnsaved(v: boolean): void {
  dirty = v;
}

export function hasUnsaved(): boolean {
  return dirty;
}

/** True when it is fine to leave (nothing unsaved, or the user agreed to discard). */
export function confirmLeave(): boolean {
  if (!dirty) return true;
  const ok = window.confirm('저장하지 않은 변경이 있습니다. 버리고 이동할까요?');
  if (ok) dirty = false;
  return ok;
}
