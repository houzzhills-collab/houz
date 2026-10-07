"use client";

import { ApartmentEditor } from "../../workspace/apartment-editor";
import { Workspace } from "../../workspace/workspace";

export default function NewApartmentPage() {
  return (
    <Workspace
      page={{
        section: "Apartments",
        title: "Add an apartment",
        description: "Fill in the listing, add photos, then create it as a draft or publish it straight away.",
        permission: "rooms:create",
        render: (props) => <ApartmentEditor {...props} />,
      }}
    />
  );
}
