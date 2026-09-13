use crate::{Lease, Renew};

pub fn refresh(addr: u32) -> Lease {
    let mut lease = Lease::new(addr);
    lease.renew(3600);
    if lease.expired() {
        panic!("fresh lease already expired");
    }
    lease
}
