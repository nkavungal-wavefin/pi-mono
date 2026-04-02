FROM alpine:3.22

RUN apk add --no-cache --no-check-certificate \
  bash \
  coreutils \
  curl \
  fd \
  file \
  findutils \
  git \
  github-cli \
  grep \
  jq \
  less \
  procps \
  ripgrep \
  sed \
  tar

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
