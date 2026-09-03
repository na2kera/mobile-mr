export type PlayerNameFieldOptions = {
  input: HTMLInputElement;
  error: HTMLElement;
  maxLength: number;
};

/** サーバーの parseName と同じ規則で、表示名を URL・通信へ渡せる形に揃える。 */
export function normalizePlayerName(raw: string, maxLength: number): string {
  const cleaned = raw.trim().replace(/\p{Cc}/gu, "");
  return [...cleaned].slice(0, maxLength).join("");
}

/**
 * 既存の ?name= を入力欄へ復元し、開始時に確定した名前を現在の URL へ反映する。
 * reload は行わず、同じユーザージェスチャー内でカメラ・センサー許可へ進めるようにする。
 */
export function setupPlayerNameField({ input, error, maxLength }: PlayerNameFieldOptions) {
  input.value = normalizePlayerName(new URL(location.href).searchParams.get("name") ?? "", maxLength);

  const clearError = () => {
    error.hidden = true;
    error.textContent = "";
    input.removeAttribute("aria-invalid");
  };

  input.addEventListener("input", clearError);

  return () => {
    const name = normalizePlayerName(input.value, maxLength);
    input.value = name;
    if (!name) {
      error.hidden = false;
      error.textContent = "名前を入力してください";
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return null;
    }

    clearError();
    const url = new URL(location.href);
    url.searchParams.set("name", name);
    history.replaceState(history.state, "", url);
    return name;
  };
}
