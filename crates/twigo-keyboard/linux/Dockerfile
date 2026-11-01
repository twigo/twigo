# The Linux side of twigo-keyboard's tests: Ubuntu's GTK, Wayland and
# xkbcommon, Xvfb for the live X11 test, as in CI, and a headless sway with
# wtype's virtual keyboard for the live Wayland test.
FROM ubuntu:24.04

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    libgtk-3-dev \
    libxkbcommon-x11-dev \
    pkg-config \
    sway \
    wtype \
    x11-xkb-utils \
    xauth \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --default-toolchain none
ENV PATH=/root/.cargo/bin:$PATH

WORKDIR /src
