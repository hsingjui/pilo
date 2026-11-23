import { context, token, type Accessor } from "nsh";

export const Foreground = context<Accessor<string>>(() => token("foreground"));
