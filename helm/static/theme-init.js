// Applied before first paint to avoid a theme flash. (Separate file because the CSP forbids inline scripts.)
// Dark by default, like Orbital; the toggle stores an explicit choice.
try {
  const t = localStorage.getItem("helm-theme");
  document.documentElement.dataset.theme = t === "light" ? "light" : "dark";
} catch (e) { document.documentElement.dataset.theme = "dark"; }
