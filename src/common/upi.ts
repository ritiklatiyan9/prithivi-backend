/** NPCI virtual payment address: handle@psp, e.g. "name-1@okhdfcbank". */
export const UPI_VPA_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,255}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

export const UPI_VPA_MESSAGE = "Enter a valid UPI ID (e.g. name@bank)";
