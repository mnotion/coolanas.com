// checking the PIN before the workspace loads
if (sessionStorage.getItem("coolanas-pin-unlocked") !== "1") {
    location.replace("../../pin.html");
}
